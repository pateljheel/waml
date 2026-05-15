import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  appendJobEvent,
  cancelJob,
  claimNextQueuedJob,
  completeJob,
  deleteCacheChunk,
  deleteCacheChunksForObject,
  ensureRuntimeDirectories,
  failJob,
  getCacheDirectoryPath,
  getCacheChunk,
  getDatabaseFilePath,
  getJob,
  getTotalCacheSizeBytes,
  initializeDatabase,
  isJobCancellationRequested,
  listCacheChunksForObject,
  listCacheEvictionCandidates,
  touchCacheChunk,
  upsertCacheChunk,
  updateJobProgress,
} from "@waml/db";
import {
  deriveCoarseTimeRangeFromMappings,
  doesRangeOverlap,
  extractLineTimestamp,
  isTimestampInRange,
  parseQueryTimestamp,
} from "@waml/shared";
import type { SearchJob, SearchMatch } from "@waml/shared";
import {
  addTrigrams,
  buildPatternTrigrams,
  createObjectCacheKey,
  getCacheBudgetBytes,
  getObjectCachePaths,
  shouldUseTrigramPrefilter,
} from "./cache";
import {
  isGzipObject,
  looksBinaryBuffer,
  shouldSkipObjectByContentType,
  shouldSkipObjectByKey,
} from "./content-detection";
import {
  extractCustomValues,
  extractHiveValues,
  objectMatchesFilters,
} from "./path-filters";
import { createS3Client, sendWithCredentialRefresh } from "./s3";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
const pollIntervalMs = 600;
const progressIntervalMs = 500;
const matchFlushIntervalMs = 250;
const matchFlushSize = 50;
const cacheChunkLineLimit = 2000;
const cacheChunkTextBytesLimit = 512 * 1024;

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function scanCachedTextFile({
  filepath,
  job,
  objectKey,
  progress,
  pendingMatches,
  lastProgressAt,
  lastMatchAt,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  filepath: string;
  job: SearchJob;
  objectKey: string;
  progress: SearchJob["progress"];
  pendingMatches: SearchMatch[];
  lastProgressAt: { value: number };
  lastMatchAt: { value: number };
  queryStartEpochMs: number | null;
  queryEndEpochMs: number | null;
}) {
  const matcher = createSubstringMatcher(job);
  const decoder = new TextDecoder("utf-8");
  const stream = fsSync.createReadStream(filepath);
  let bufferedText = "";
  let lineNumber = 0;

  for await (const rawChunk of stream) {
    if (isJobCancellationRequested(job.id)) {
      stream.destroy();
      throw new Error("JOB_CANCELLED");
    }

    const chunkBuffer = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    progress.bytesScanned += chunkBuffer.byteLength;
    bufferedText += decoder.decode(chunkBuffer, { stream: true });

    const lines = bufferedText.split(/\r?\n/);
    bufferedText = lines.pop() ?? "";

    for (const lineText of lines) {
      lineNumber += 1;

      if (!matcher.matches(lineText)) {
        continue;
      }

      const timestampResult = extractLineTimestamp(
        job.timeConfig.lineParser,
        lineText,
        job.timeConfig.timezone,
      );
      const parsedLineTimestamp = timestampResult.lineTimestamp
        ? parseQueryTimestamp(timestampResult.lineTimestamp)
        : null;

      if (
        (queryStartEpochMs !== null || queryEndEpochMs !== null) &&
        job.timeConfig.lineParser.mode !== "none" &&
        (parsedLineTimestamp === null ||
          !isTimestampInRange(
            parsedLineTimestamp,
            queryStartEpochMs,
            queryEndEpochMs,
          ))
      ) {
        continue;
      }

      pendingMatches.push({
        objectKey,
        lineNumber,
        lineText,
        timestampText: timestampResult.lineTimestamp ?? undefined,
      });
      progress.matchesFound += 1;
    }

    const now = Date.now();

    if (
      pendingMatches.length >= matchFlushSize ||
      now - lastMatchAt.value >= matchFlushIntervalMs
    ) {
      await flushMatches(job.id, pendingMatches);
      lastMatchAt.value = now;
    }

    if (now - lastProgressAt.value >= progressIntervalMs) {
      await flushProgress(job.id, progress);
      lastProgressAt.value = now;
    }
  }

  bufferedText += decoder.decode();

  if (bufferedText && matcher.matches(bufferedText)) {
    lineNumber += 1;
    const timestampResult = extractLineTimestamp(
      job.timeConfig.lineParser,
      bufferedText,
      job.timeConfig.timezone,
    );
    const parsedLineTimestamp = timestampResult.lineTimestamp
      ? parseQueryTimestamp(timestampResult.lineTimestamp)
      : null;

    if (
      (queryStartEpochMs === null && queryEndEpochMs === null) ||
      job.timeConfig.lineParser.mode === "none" ||
      (parsedLineTimestamp !== null &&
        isTimestampInRange(parsedLineTimestamp, queryStartEpochMs, queryEndEpochMs))
    ) {
      pendingMatches.push({
        objectKey,
        lineNumber,
        lineText: bufferedText,
        timestampText: timestampResult.lineTimestamp ?? undefined,
      });
      progress.matchesFound += 1;
    }
  }
}

async function writeCachedChunkArtifact({
  job,
  objectKey,
  etag,
  objectSize,
  chunkId,
  chunkText,
  byteStart,
  byteEnd,
}: {
  job: SearchJob;
  objectKey: string;
  etag: string;
  objectSize: number;
  chunkId: string;
  chunkText: string;
  byteStart: number;
  byteEnd: number;
}) {
  const chunkPk = createObjectCacheKey(job.source.bucket, objectKey, etag, chunkId);
  const cachePaths = getObjectCachePaths(chunkPk);
  const tempTextPath = `${cachePaths.textPath}.${process.pid}.tmp`;
  const tempTrigramPath = `${cachePaths.trigramPath}.${process.pid}.tmp`;
  const trigramSet = new Set<string>();
  addTrigrams(trigramSet, chunkText);

  await fs.mkdir(cachePaths.directory, { recursive: true });
  await fs.writeFile(tempTextPath, chunkText, "utf8");
  await fs.writeFile(
    tempTrigramPath,
    JSON.stringify([...trigramSet.values()].sort()),
    "utf8",
  );
  await fs.rename(tempTextPath, cachePaths.textPath);
  await fs.rename(tempTrigramPath, cachePaths.trigramPath);

  const [textStats, trigramStats] = await Promise.all([
    fs.stat(cachePaths.textPath),
    fs.stat(cachePaths.trigramPath),
  ]);

  const cacheSizeBytes = textStats.size + trigramStats.size;
  const lineCount =
    chunkText.length === 0 ? 0 : chunkText.split(/\r?\n/).length;

  upsertCacheChunk({
    chunkPk,
    bucket: job.source.bucket,
    objectKey,
    etag,
    chunkId,
    byteStart,
    byteEnd: Math.min(byteEnd, objectSize),
    artifactPath: cachePaths.trigramPath,
    textCachePath: cachePaths.textPath,
    cacheSizeBytes,
    trigramCount: trigramSet.size,
    lineCount,
  });
  appendJobEvent(job.id, "cache.write", {
    objectKey,
    chunkPk,
    chunkId,
    cacheSizeBytes,
    trigramCount: trigramSet.size,
  });
}

async function enforceCacheBudget(jobId: string) {
  const budgetBytes = getCacheBudgetBytes();
  let totalBytes = getTotalCacheSizeBytes();

  if (totalBytes <= budgetBytes) {
    return;
  }

  const candidates = listCacheEvictionCandidates(200);

  for (const candidate of candidates) {
    if (totalBytes <= budgetBytes) {
      break;
    }

    const removed = deleteCacheChunk(candidate.chunkPk);

    if (!removed) {
      continue;
    }

    await Promise.allSettled([
      fs.rm(removed.artifactPath, { force: true }),
      removed.textCachePath
        ? fs.rm(removed.textCachePath, { force: true })
        : Promise.resolve(),
    ]);

    totalBytes -= removed.cacheSizeBytes;
    appendJobEvent(jobId, "cache.evicted", {
      objectKey: removed.objectKey,
      chunkPk: removed.chunkPk,
      chunkId: removed.chunkId,
      cacheSizeBytes: removed.cacheSizeBytes,
    });
  }
}

function createSubstringMatcher(job: SearchJob) {
  const caseSensitive = job.searchOptions.caseSensitive;
  const normalizedPattern = caseSensitive
    ? job.pattern
    : job.pattern.toLocaleLowerCase();

  return {
    caseSensitive,
    matches(lineText: string) {
      const haystack = caseSensitive ? lineText : lineText.toLocaleLowerCase();
      return haystack.includes(normalizedPattern);
    },
  };
}

async function flushProgress(jobId: string, progress: SearchJob["progress"]) {
  const job = updateJobProgress(jobId, progress);

  if (job) {
    appendJobEvent(jobId, "job.progress", {
      progress: job.progress,
      status: job.status,
    });
  }
}

async function flushMatches(jobId: string, matches: SearchMatch[]) {
  if (matches.length === 0) {
    return;
  }

  appendJobEvent(jobId, "match.batch", {
    count: matches.length,
    results: matches,
  });
  matches.length = 0;
}

async function processObject({
  clientRef,
  job,
  objectKey,
  etag,
  objectSize,
  relativePath,
  progress,
  pendingMatches,
  lastProgressAt,
  lastMatchAt,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  clientRef: { current: S3Client };
  job: SearchJob;
  objectKey: string;
  etag: string;
  objectSize: number;
  relativePath: string;
  progress: SearchJob["progress"];
  pendingMatches: SearchMatch[];
  lastProgressAt: { value: number };
  lastMatchAt: { value: number };
  queryStartEpochMs: number | null;
  queryEndEpochMs: number | null;
}) {
  const matcher = createSubstringMatcher(job);
  const gzipObject = isGzipObject(objectKey);
  const cachedChunks = listCacheChunksForObject(job.source.bucket, objectKey, etag);
  const partitionValues =
    extractCustomValues(relativePath, job.customPathPattern) ??
    extractHiveValues(relativePath);
  const coarseTimeRange = deriveCoarseTimeRangeFromMappings(
    job.timeConfig.pathMappings,
    partitionValues,
    job.timeConfig.timezone,
  ).range;

  if (
    (queryStartEpochMs !== null || queryEndEpochMs !== null) &&
    !doesRangeOverlap(coarseTimeRange, queryStartEpochMs, queryEndEpochMs)
  ) {
    appendJobEvent(job.id, "object.skipped", {
      objectKey,
      reason: "time_range_prune",
    });
    return;
  }

  const validCachedChunks = cachedChunks.filter(
    (chunk) =>
      fsSync.existsSync(chunk.artifactPath) &&
      chunk.textCachePath !== null &&
      fsSync.existsSync(chunk.textCachePath),
  );

  if (cachedChunks.length > 0 && validCachedChunks.length === cachedChunks.length) {
    appendJobEvent(job.id, "object.started", { objectKey, source: "cache" });
    progress.objectsScanned += 1;

    for (const cachedChunk of validCachedChunks) {
      const chunkPk = cachedChunk.chunkPk;
      let trigramRejected = false;

      if (shouldUseTrigramPrefilter(job)) {
        try {
          const patternTrigrams = [...buildPatternTrigrams(job.pattern)];
          const cachedTrigrams = new Set<string>(
            JSON.parse(await fs.readFile(cachedChunk.artifactPath, "utf8")) as string[],
          );
          trigramRejected = patternTrigrams.some(
            (trigram) => !cachedTrigrams.has(trigram),
          );
        } catch {
          trigramRejected = false;
        }
      }

      touchCacheChunk(chunkPk);
      appendJobEvent(job.id, "cache.hit", {
        objectKey,
        chunkPk,
        chunkId: cachedChunk.chunkId,
        trigramRejected,
      });

      if (trigramRejected) {
        appendJobEvent(job.id, "object.skipped", {
          objectKey,
          reason: "cache_trigram_prune",
          chunkId: cachedChunk.chunkId,
        });
        continue;
      }

      appendJobEvent(job.id, "chunk.started", {
        objectKey,
        chunkId: cachedChunk.chunkId,
        source: "cache",
      });
      progress.chunksScanned += 1;

      await scanCachedTextFile({
        filepath: cachedChunk.textCachePath!,
        job,
        objectKey,
        progress,
        pendingMatches,
        lastProgressAt,
        lastMatchAt,
        queryStartEpochMs,
        queryEndEpochMs,
      });
    }
    return;
  }

  if (cachedChunks.length > 0) {
    const staleChunks = deleteCacheChunksForObject(job.source.bucket, objectKey, etag);
    await Promise.allSettled(
      staleChunks.flatMap((chunk) => [
        fs.rm(chunk.artifactPath, { force: true }),
        chunk.textCachePath
          ? fs.rm(chunk.textCachePath, { force: true })
          : Promise.resolve(),
      ]),
    );
  }

  appendJobEvent(job.id, "cache.miss", {
    objectKey,
    chunkCount: 0,
  });

  if (!gzipObject && shouldSkipObjectByKey(objectKey)) {
    appendJobEvent(job.id, "object.skipped", {
      objectKey,
      reason: "binary_extension",
    });
    return;
  }

  const controller = new AbortController();
  const response = await sendWithCredentialRefresh({
    clientRef,
    profile: job.source.awsProfile,
    operation: (client) =>
      client.send(
        new GetObjectCommand({
          Bucket: job.source.bucket,
          Key: objectKey,
        }),
        {
          abortSignal: controller.signal,
        },
      ),
  });

  const body = response.Body as AsyncIterable<Uint8Array | Buffer | string> | undefined;
  const sourceStream =
    body && typeof (body as NodeJS.ReadableStream).pipe === "function"
      ? (body as Readable)
      : body
        ? Readable.from(body)
        : undefined;

  if (!sourceStream) {
    return;
  }

  if (!gzipObject && shouldSkipObjectByContentType(response.ContentType)) {
    sourceStream.destroy();
    appendJobEvent(job.id, "object.skipped", {
      objectKey,
      reason: "binary_content_type",
      contentType: response.ContentType ?? null,
    });
    return;
  }

  const decodedBody: Readable = gzipObject
    ? sourceStream.pipe(createGunzip())
    : sourceStream;

  appendJobEvent(job.id, "object.started", { objectKey });
  progress.objectsScanned += 1;

  const decoder = new TextDecoder("utf-8");
  let bufferedText = "";
  let lineNumber = 0;
  let inspectedFirstChunk = false;
  let chunkIndex = 0;
  let chunkTextParts: string[] = [];
  let chunkTextBytes = 0;
  let chunkLineCount = 0;
  let chunkByteStart = 0;

  async function flushChunk(force = false) {
    if (!force && chunkLineCount < cacheChunkLineLimit && chunkTextBytes < cacheChunkTextBytesLimit) {
      return;
    }

    if (chunkTextParts.length === 0) {
      return;
    }

    const chunkText = chunkTextParts.join("");
    const chunkId = String(chunkIndex);
    appendJobEvent(job.id, "chunk.started", {
      objectKey,
      chunkId,
      source: "stream",
    });
    progress.chunksScanned += 1;
    await writeCachedChunkArtifact({
      job,
      objectKey,
      etag,
      objectSize,
      chunkId,
      chunkText,
      byteStart: chunkByteStart,
      byteEnd: chunkByteStart + chunkTextBytes,
    });
    chunkIndex += 1;
    chunkByteStart += chunkTextBytes;
    chunkTextParts = [];
    chunkTextBytes = 0;
    chunkLineCount = 0;
  }
  try {
    for await (const rawChunk of decodedBody) {
      if (isJobCancellationRequested(job.id)) {
        controller.abort();
        decodedBody.destroy();
        throw new Error("JOB_CANCELLED");
      }

      const chunkBuffer =
        typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);

      if (!inspectedFirstChunk) {
        inspectedFirstChunk = true;

        if (looksBinaryBuffer(chunkBuffer)) {
          controller.abort();
          appendJobEvent(job.id, "object.skipped", {
            objectKey,
            reason: "binary_sniff",
          });
          return;
        }
      }

      progress.bytesScanned += chunkBuffer.byteLength;
      const decodedChunk = decoder.decode(chunkBuffer, { stream: true });
      bufferedText += decodedChunk;

      const lines = bufferedText.split(/\r?\n/);
      bufferedText = lines.pop() ?? "";

      for (const lineText of lines) {
        lineNumber += 1;
        const lineWithNewline = `${lineText}\n`;
        chunkTextParts.push(lineWithNewline);
        chunkTextBytes += Buffer.byteLength(lineWithNewline);
        chunkLineCount += 1;

        if (!matcher.matches(lineText)) {
          await flushChunk();
          continue;
        }

        const timestampResult = extractLineTimestamp(
          job.timeConfig.lineParser,
          lineText,
          job.timeConfig.timezone,
        );
        const parsedLineTimestamp = timestampResult.lineTimestamp
          ? parseQueryTimestamp(timestampResult.lineTimestamp)
          : null;

        if (
          (queryStartEpochMs !== null || queryEndEpochMs !== null) &&
          job.timeConfig.lineParser.mode !== "none"
        ) {
          if (
            parsedLineTimestamp === null ||
            !isTimestampInRange(
              parsedLineTimestamp,
              queryStartEpochMs,
              queryEndEpochMs,
            )
          ) {
            continue;
          }
        }

        pendingMatches.push({
          objectKey,
          lineNumber,
          lineText,
          timestampText: timestampResult.lineTimestamp ?? undefined,
        });
        progress.matchesFound += 1;
        await flushChunk();
      }

      const now = Date.now();

      if (
        pendingMatches.length >= matchFlushSize ||
        now - lastMatchAt.value >= matchFlushIntervalMs
      ) {
        await flushMatches(job.id, pendingMatches);
        lastMatchAt.value = now;
      }

      if (now - lastProgressAt.value >= progressIntervalMs) {
        await flushProgress(job.id, progress);
        lastProgressAt.value = now;
      }
    }

    bufferedText += decoder.decode();

    if (bufferedText) {
      lineNumber += 1;
      chunkTextParts.push(bufferedText);
      chunkTextBytes += Buffer.byteLength(bufferedText);
      chunkLineCount += 1;

      if (matcher.matches(bufferedText)) {
        const timestampResult = extractLineTimestamp(
          job.timeConfig.lineParser,
          bufferedText,
          job.timeConfig.timezone,
        );
        const parsedLineTimestamp = timestampResult.lineTimestamp
          ? parseQueryTimestamp(timestampResult.lineTimestamp)
          : null;

        if (
          (queryStartEpochMs === null && queryEndEpochMs === null) ||
          job.timeConfig.lineParser.mode === "none" ||
          (parsedLineTimestamp !== null &&
            isTimestampInRange(
              parsedLineTimestamp,
              queryStartEpochMs,
              queryEndEpochMs,
            ))
        ) {
          pendingMatches.push({
            objectKey,
            lineNumber,
            lineText: bufferedText,
            timestampText: timestampResult.lineTimestamp ?? undefined,
          });
          progress.matchesFound += 1;
        }
      }
    }
    await flushChunk(true);
    await enforceCacheBudget(job.id);
  } finally {
    // Chunk artifacts are committed chunk-by-chunk; no object-level temp files remain here.
  }
}

async function runSearchJob(job: SearchJob) {
  const clientRef = {
    current: await createS3Client(job.source.awsProfile),
  };
  const progress = { ...job.progress };
  const pendingMatches: SearchMatch[] = [];
  const lastProgressAt = { value: Date.now() };
  const lastMatchAt = { value: Date.now() };
  let continuationToken: string | undefined;
  const queryStartEpochMs = parseQueryTimestamp(
    job.startTime,
    job.timeConfig.timezone,
  );
  const queryEndEpochMs = parseQueryTimestamp(
    job.endTime,
    job.timeConfig.timezone,
  );

  while (true) {
    if (isJobCancellationRequested(job.id)) {
      await flushMatches(job.id, pendingMatches);
      await flushProgress(job.id, progress);
      cancelJob(job.id);
      return;
    }

    const response = await sendWithCredentialRefresh({
      clientRef,
      profile: job.source.awsProfile,
      operation: (client) =>
        client.send(
          new ListObjectsV2Command({
            Bucket: job.source.bucket,
            Prefix: job.source.rootPrefix.trim() || undefined,
            ContinuationToken: continuationToken,
            MaxKeys: 250,
          }),
        ),
    });

    const objects = (response.Contents ?? [])
      .map(
        (entry: {
          Key?: string;
          ETag?: string;
          Size?: number;
        }) => ({
          key: entry.Key,
          etag: entry.ETag?.replaceAll('"', "") ?? "",
          size: entry.Size ?? 0,
        }),
      )
      .filter(
        (
          entry,
        ): entry is {
          key: string;
          etag: string;
          size: number;
        } => Boolean(entry.key) && entry.key !== job.source.rootPrefix,
      );

    for (const object of objects) {
      if (!objectMatchesFilters(job, object.key)) {
        continue;
      }

      const rootPrefix = job.source.rootPrefix.trim();
      const relativePath = rootPrefix
        ? object.key.slice(rootPrefix.length)
        : object.key;

      await processObject({
        clientRef,
        job,
        objectKey: object.key,
        etag: object.etag,
        objectSize: object.size,
        relativePath,
        progress,
        pendingMatches,
        lastProgressAt,
        lastMatchAt,
        queryStartEpochMs,
        queryEndEpochMs,
      });
    }

    continuationToken = response.NextContinuationToken ?? undefined;

    if (!continuationToken) {
      break;
    }
  }

  await flushMatches(job.id, pendingMatches);
  await flushProgress(job.id, progress);
  completeJob(job.id);
}

async function processNextJob() {
  const job = claimNextQueuedJob();

  if (!job) {
    return false;
  }

  try {
    await runSearchJob(job);
  } catch (error) {
    const latest = getJob(job.id);

    if ((error as Error).message === "JOB_CANCELLED" || latest?.status === "cancelling") {
      cancelJob(job.id);
      return true;
    }

    const message =
      error instanceof Error ? error.message : "Unexpected search failure";
    failJob(job.id, message);
  }

  return true;
}

async function main() {
  ensureRuntimeDirectories();
  initializeDatabase();

  const startupDetails = {
    db: getDatabaseFilePath(),
    cacheDir: getCacheDirectoryPath(),
    mode: "worker",
  };

  console.log("[waml-worker] started", startupDetails);
  console.log("[waml-worker] polling for search jobs");

  while (true) {
    const processed = await processNextJob();

    if (!processed) {
      await sleep(pollIntervalMs);
    }
  }
}

main().catch((error) => {
  console.error("[waml-worker] fatal", error);
  process.exitCode = 1;
});
