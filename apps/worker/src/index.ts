import {
  appendJobResults,
  appendJobEvent,
  cancelJob,
  claimNextQueuedJob,
  completeJob,
  countJobResults,
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
  pauseJob,
  touchCacheChunk,
  upsertCacheChunk,
  updateJobProgress,
} from "@waml/db";
import {
  deriveCoarseTimeRangeFromMappings,
  doesRangeOverlap,
  extractCustomValues,
  extractHiveValues,
  extractLineTimestamp,
  isTimestampInRange,
  parseQueryTimestamp,
} from "@waml/shared";
import type { SearchJob, SearchMatch } from "@waml/shared";
import {
  addTrigrams,
  buildPatternTrigrams,
  buildTokenPostingIndex,
  createObjectCacheKey,
  getCandidateLineNumbersFromTokenIndex,
  getCacheBudgetBytes,
  getObjectCachePaths,
  packedTrigramArtifactContainsAll,
  readCompressedTextArtifact,
  shouldUseTrigramPrefilter,
  tokenizeText,
  writeCompressedTextArtifact,
  writeCompressedTokenIndexArtifact,
  writePackedTrigramArtifact,
} from "./cache";
import {
  isGzipObject,
  looksBinaryBuffer,
  shouldSkipObjectByContentType,
  shouldSkipObjectByKey,
} from "./content-detection";
import {
  objectMatchesFilters,
} from "./path-filters";
import {
  deriveManifestScopePrefixes,
  loadManifestScopeObjects,
} from "./manifest";
import { createObjectStoreReader } from "./storage";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
const pollIntervalMs = 600;
const progressIntervalMs = 500;
const matchFlushIntervalMs = 250;
const matchFlushSize = 50;
const cacheChunkLineLimit = 2000;
const cacheChunkTextBytesLimit = 512 * 1024;
const workerHealthDirectory = process.env.WAML_HEALTH_DIR || path.join("var", "health");
const workerHeartbeatFile =
  process.env.WAML_WORKER_HEARTBEAT_FILE ||
  path.join(workerHealthDirectory, "worker-heartbeat");

type FullTextQuery = {
  includeTokens: string[];
  excludeTokens: string[];
  includePhrases: string[];
  excludePhrases: string[];
  prefilterTokens: string[];
};

type SearchMatcher = {
  matches(lineText: string): boolean;
  prefilterTokens: string[];
};

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function tokenizeLineForMatch(value: string, caseSensitive: boolean) {
  const matches = value.match(/[A-Za-z0-9_]+/g);

  if (!matches) {
    return [];
  }

  return caseSensitive ? matches : matches.map((token) => token.toLocaleLowerCase());
}

function parseFullTextQuery(pattern: string, caseSensitive: boolean): FullTextQuery {
  const parts = pattern.match(/-?"[^"]+"|-?\S+/g) ?? [];
  const includeTokens = new Set<string>();
  const excludeTokens = new Set<string>();
  const includePhrases = new Set<string>();
  const excludePhrases = new Set<string>();
  const prefilterTokens = new Set<string>();

  for (const part of parts) {
    const negative = part.startsWith("-");
    const body = negative ? part.slice(1) : part;

    if (!body) {
      continue;
    }

    if (body.startsWith("\"") && body.endsWith("\"") && body.length >= 2) {
      const phrase = body.slice(1, -1);
      const normalizedPhrase = caseSensitive ? phrase : phrase.toLocaleLowerCase();

      if (!normalizedPhrase) {
        continue;
      }

      if (negative) {
        excludePhrases.add(normalizedPhrase);
      } else {
        includePhrases.add(normalizedPhrase);

        for (const token of tokenizeText(phrase)) {
          prefilterTokens.add(token);
        }
      }

      continue;
    }

    const normalizedToken = caseSensitive ? body : body.toLocaleLowerCase();

    if (!normalizedToken) {
      continue;
    }

    if (negative) {
      excludeTokens.add(normalizedToken);
    } else {
      includeTokens.add(normalizedToken);
      prefilterTokens.add(normalizedToken.toLocaleLowerCase());
    }
  }

  return {
    includeTokens: [...includeTokens],
    excludeTokens: [...excludeTokens],
    includePhrases: [...includePhrases],
    excludePhrases: [...excludePhrases],
    prefilterTokens: [...prefilterTokens],
  };
}

async function scanCachedTextFile({
  filepath,
  job,
  objectKey,
  versionToken,
  etag,
  baseLineNumber,
  candidateLineNumbers,
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
  versionToken: string;
  etag: string;
  baseLineNumber: number;
  candidateLineNumbers: Set<number> | null;
  progress: SearchJob["progress"];
  pendingMatches: SearchMatch[];
  lastProgressAt: { value: number };
  lastMatchAt: { value: number };
  queryStartEpochMs: number | null;
  queryEndEpochMs: number | null;
}) {
  const matcher = createSearchMatcher(job);
  const text = await readCompressedTextArtifact(filepath);
  let lineNumber = baseLineNumber - 1;
  progress.bytesScanned += Buffer.byteLength(text);
  const lines = text.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  for (const lineText of lines) {
    if (isJobCancellationRequested(job.id)) {
      throw new Error("JOB_CANCELLED");
    }

    lineNumber += 1;

    if (candidateLineNumbers && !candidateLineNumbers.has(lineNumber)) {
      continue;
    }

    if (!matcher.matches(lineText)) {
      continue;
    }

    const timestampResult = extractLineTimestamp(
      job.timeConfig.lineParser,
      lineText,
      job.timeConfig.timezone,
    );
    const parsedLineTimestamp = timestampResult.lineTimestamp
      ? parseQueryTimestamp(
          timestampResult.lineTimestamp,
          job.timeConfig.timezone,
        )
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
      versionToken,
      etag,
      lineNumber,
      lineText,
      timestampText: timestampResult.lineTimestamp ?? undefined,
    });
    progress.matchesFound += 1;

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
}

async function writeCachedChunkArtifact({
  job,
  objectKey,
  versionToken,
  etag,
  objectSize,
  chunkId,
  chunkText,
  byteStart,
  byteEnd,
  lineCount,
  startLineNumber,
  endLineNumber,
  minTimestampMs,
  maxTimestampMs,
}: {
  job: SearchJob;
  objectKey: string;
  versionToken: string;
  etag: string;
  objectSize: number;
  chunkId: string;
  chunkText: string;
  byteStart: number;
  byteEnd: number;
  lineCount: number;
  startLineNumber: number | null;
  endLineNumber: number | null;
  minTimestampMs: number | null;
  maxTimestampMs: number | null;
}) {
  const chunkPk = createObjectCacheKey(
    job.source.provider,
    job.source.bucket,
    objectKey,
    versionToken,
    chunkId,
  );
  const cachePaths = getObjectCachePaths(chunkPk);
  const tempTextPath = `${cachePaths.textPath}.${process.pid}.tmp`;
  const tempTrigramPath = `${cachePaths.trigramPath}.${process.pid}.tmp`;
  const tempTokenIndexPath = `${cachePaths.tokenIndexPath}.${process.pid}.tmp`;
  const trigramSet = new Set<number>();
  addTrigrams(trigramSet, chunkText);
  const tokenIndex = buildTokenPostingIndex(chunkText, startLineNumber ?? 1);

  await fs.mkdir(cachePaths.directory, { recursive: true });
  await writeCompressedTextArtifact(tempTextPath, chunkText);
  await writePackedTrigramArtifact(tempTrigramPath, trigramSet);
  await writeCompressedTokenIndexArtifact(tempTokenIndexPath, tokenIndex);
  await fs.rename(tempTextPath, cachePaths.textPath);
  await fs.rename(tempTrigramPath, cachePaths.trigramPath);
  await fs.rename(tempTokenIndexPath, cachePaths.tokenIndexPath);

  const [textStats, trigramStats, tokenIndexStats] = await Promise.all([
    fs.stat(cachePaths.textPath),
    fs.stat(cachePaths.trigramPath),
    fs.stat(cachePaths.tokenIndexPath),
  ]);

  const cacheSizeBytes = textStats.size + trigramStats.size + tokenIndexStats.size;

  upsertCacheChunk({
    chunkPk,
    provider: job.source.provider,
    bucket: job.source.bucket,
    objectKey,
    versionToken,
    etag,
    chunkId,
    byteStart,
    byteEnd: Math.min(byteEnd, objectSize),
    startLineNumber,
    endLineNumber,
    artifactPath: cachePaths.trigramPath,
    textCachePath: cachePaths.textPath,
    tokenIndexPath: cachePaths.tokenIndexPath,
    cacheSizeBytes,
    trigramCount: trigramSet.size,
    tokenCount: tokenIndex.size,
    lineCount,
    minTimestampMs,
    maxTimestampMs,
  });
  appendJobEvent(job.id, "cache.write", {
    objectKey,
    chunkPk,
    chunkId,
    cacheSizeBytes,
    trigramCount: trigramSet.size,
    tokenCount: tokenIndex.size,
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
      removed.tokenIndexPath
        ? fs.rm(removed.tokenIndexPath, { force: true })
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

function createSearchMatcher(job: SearchJob): SearchMatcher {
  const caseSensitive = job.searchOptions.caseSensitive;
  const normalizedPattern = caseSensitive
    ? job.pattern
    : job.pattern.toLocaleLowerCase();
  const normalizedTokens =
    job.mode === "all_tokens"
      ? normalizedPattern
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean)
      : [];
  const fullTextQuery =
    job.mode === "full_text"
      ? parseFullTextQuery(job.pattern, caseSensitive)
      : null;

  return {
    prefilterTokens: !caseSensitive && fullTextQuery ? fullTextQuery.prefilterTokens : [],
    matches(lineText: string) {
      const haystack = caseSensitive ? lineText : lineText.toLocaleLowerCase();

      if (job.mode === "full_text" && fullTextQuery) {
        const tokenSet = new Set(tokenizeLineForMatch(lineText, caseSensitive));

        if (fullTextQuery.includeTokens.some((token) => !tokenSet.has(token))) {
          return false;
        }

        if (fullTextQuery.excludeTokens.some((token) => tokenSet.has(token))) {
          return false;
        }

        if (
          fullTextQuery.includePhrases.some((phrase) => !haystack.includes(phrase))
        ) {
          return false;
        }

        if (
          fullTextQuery.excludePhrases.some((phrase) => haystack.includes(phrase))
        ) {
          return false;
        }

        return true;
      }

      if (job.mode === "all_tokens") {
        return normalizedTokens.every((token) => haystack.includes(token));
      }

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

  const added = appendJobResults(jobId, matches);
  appendJobEvent(jobId, "results.available", {
    count: added,
    totalResults: countJobResults(jobId),
  });
  matches.length = 0;
}

async function processObject({
  reader,
  job,
  objectKey,
  versionToken,
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
  reader: Awaited<ReturnType<typeof createObjectStoreReader>>;
  job: SearchJob;
  objectKey: string;
  versionToken: string;
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
  const matcher = createSearchMatcher(job);
  const gzipObject = isGzipObject(objectKey);
  const patternTrigrams =
    job.mode !== "full_text" && shouldUseTrigramPrefilter(job)
    ? buildPatternTrigrams(job.pattern)
    : null;
  const cachedChunks = listCacheChunksForObject(
    job.source.provider,
    job.source.bucket,
    objectKey,
    versionToken,
  );
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
      let tokenIndexRejected = false;
      let candidateLineNumbers: Set<number> | null = null;
      const chunkTimePruned =
        (queryStartEpochMs !== null || queryEndEpochMs !== null) &&
        cachedChunk.minTimestampMs !== null &&
        cachedChunk.maxTimestampMs !== null &&
        !doesRangeOverlap(
          {
            startEpochMs: cachedChunk.minTimestampMs,
            endEpochMs: cachedChunk.maxTimestampMs,
          },
          queryStartEpochMs,
          queryEndEpochMs,
        );

      if (!chunkTimePruned && patternTrigrams !== null) {
        try {
          trigramRejected = !(await packedTrigramArtifactContainsAll(
            cachedChunk.artifactPath,
            patternTrigrams,
          ));
        } catch {
          trigramRejected = false;
        }
      }

      if (
        !chunkTimePruned &&
        !trigramRejected &&
        job.mode === "full_text" &&
        matcher.prefilterTokens.length > 0 &&
        cachedChunk.tokenIndexPath
      ) {
        try {
          candidateLineNumbers = await getCandidateLineNumbersFromTokenIndex(
            cachedChunk.tokenIndexPath,
            matcher.prefilterTokens,
          );
          tokenIndexRejected =
            candidateLineNumbers !== null && candidateLineNumbers.size === 0;
        } catch {
          candidateLineNumbers = null;
          tokenIndexRejected = false;
        }
      }

      if (chunkTimePruned) {
        appendJobEvent(job.id, "object.skipped", {
          objectKey,
          reason: "cache_time_prune",
          chunkId: cachedChunk.chunkId,
        });
      }

      touchCacheChunk(chunkPk);
      appendJobEvent(job.id, "cache.hit", {
        objectKey,
        chunkPk,
        chunkId: cachedChunk.chunkId,
        trigramRejected,
        tokenIndexRejected,
        timePruned: chunkTimePruned,
      });

      if (chunkTimePruned || trigramRejected || tokenIndexRejected) {
        if (trigramRejected) {
          appendJobEvent(job.id, "object.skipped", {
            objectKey,
            reason: "cache_trigram_prune",
            chunkId: cachedChunk.chunkId,
          });
        }
        if (tokenIndexRejected) {
          appendJobEvent(job.id, "object.skipped", {
            objectKey,
            reason: "cache_token_prune",
            chunkId: cachedChunk.chunkId,
          });
        }
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
        versionToken,
        etag,
        baseLineNumber: cachedChunk.startLineNumber ?? 1,
        candidateLineNumbers,
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
    const staleChunks = deleteCacheChunksForObject(
      job.source.provider,
      job.source.bucket,
      objectKey,
      versionToken,
    );
    await Promise.allSettled(
      staleChunks.flatMap((chunk) => [
        fs.rm(chunk.artifactPath, { force: true }),
        chunk.textCachePath
          ? fs.rm(chunk.textCachePath, { force: true })
          : Promise.resolve(),
        chunk.tokenIndexPath
          ? fs.rm(chunk.tokenIndexPath, { force: true })
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
  const response = await reader.getObject({
    bucket: job.source.bucket,
    key: objectKey,
    abortSignal: controller.signal,
  });

  const body = response.body as AsyncIterable<Uint8Array | Buffer | string> | undefined;
  const sourceStream =
    body && typeof (body as NodeJS.ReadableStream).pipe === "function"
      ? (body as Readable)
      : body
        ? Readable.from(body)
        : undefined;

  if (!sourceStream) {
    return;
  }

  if (!gzipObject && shouldSkipObjectByContentType(response.contentType)) {
    sourceStream.destroy();
    appendJobEvent(job.id, "object.skipped", {
      objectKey,
      reason: "binary_content_type",
      contentType: response.contentType ?? null,
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
  let chunkStartLineNumber: number | null = null;
  let chunkMinTimestampMs: number | null = null;
  let chunkMaxTimestampMs: number | null = null;

  async function flushChunk(force = false) {
    if (
      !force &&
      chunkLineCount < cacheChunkLineLimit &&
      chunkTextBytes < cacheChunkTextBytesLimit
    ) {
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
      versionToken,
      etag,
      objectSize,
      chunkId,
      chunkText,
      byteStart: chunkByteStart,
      byteEnd: chunkByteStart + chunkTextBytes,
      lineCount: chunkLineCount,
      startLineNumber: chunkStartLineNumber,
      endLineNumber:
        chunkStartLineNumber === null
          ? null
          : chunkStartLineNumber + chunkLineCount - 1,
      minTimestampMs: chunkMinTimestampMs,
      maxTimestampMs: chunkMaxTimestampMs,
    });
    chunkIndex += 1;
    chunkByteStart += chunkTextBytes;
    chunkTextParts = [];
    chunkTextBytes = 0;
    chunkLineCount = 0;
    chunkStartLineNumber = null;
    chunkMinTimestampMs = null;
    chunkMaxTimestampMs = null;
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
        if (chunkStartLineNumber === null) {
          chunkStartLineNumber = lineNumber;
        }
        const lineWithNewline = `${lineText}\n`;
        chunkTextParts.push(lineWithNewline);
        chunkTextBytes += Buffer.byteLength(lineWithNewline);
        chunkLineCount += 1;

        const timestampResult = extractLineTimestamp(
          job.timeConfig.lineParser,
          lineText,
          job.timeConfig.timezone,
        );
        const parsedLineTimestamp = timestampResult.lineTimestamp
          ? parseQueryTimestamp(
              timestampResult.lineTimestamp,
              job.timeConfig.timezone,
            )
          : null;

        if (parsedLineTimestamp !== null) {
          chunkMinTimestampMs =
            chunkMinTimestampMs === null
              ? parsedLineTimestamp
              : Math.min(chunkMinTimestampMs, parsedLineTimestamp);
          chunkMaxTimestampMs =
            chunkMaxTimestampMs === null
              ? parsedLineTimestamp
              : Math.max(chunkMaxTimestampMs, parsedLineTimestamp);
        }

        if (!matcher.matches(lineText)) {
          await flushChunk();
          continue;
        }

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
            await flushChunk();
            continue;
          }
        }

        pendingMatches.push({
          objectKey,
          versionToken,
          etag,
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
      if (chunkStartLineNumber === null) {
        chunkStartLineNumber = lineNumber;
      }
      chunkTextParts.push(bufferedText);
      chunkTextBytes += Buffer.byteLength(bufferedText);
      chunkLineCount += 1;

      const timestampResult = extractLineTimestamp(
        job.timeConfig.lineParser,
        bufferedText,
        job.timeConfig.timezone,
      );
      const parsedLineTimestamp = timestampResult.lineTimestamp
        ? parseQueryTimestamp(
            timestampResult.lineTimestamp,
            job.timeConfig.timezone,
          )
        : null;

      if (parsedLineTimestamp !== null) {
        chunkMinTimestampMs =
          chunkMinTimestampMs === null
            ? parsedLineTimestamp
            : Math.min(chunkMinTimestampMs, parsedLineTimestamp);
        chunkMaxTimestampMs =
          chunkMaxTimestampMs === null
            ? parsedLineTimestamp
            : Math.max(chunkMaxTimestampMs, parsedLineTimestamp);
      }

      if (matcher.matches(bufferedText)) {
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
            versionToken,
            etag,
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
  const reader = await createObjectStoreReader(job.source);
  const progress = { ...job.progress };
  const pendingMatches: SearchMatch[] = [];
  const lastProgressAt = { value: Date.now() };
  const lastMatchAt = { value: Date.now() };
  const queryStartEpochMs = parseQueryTimestamp(
    job.startTime,
    job.timeConfig.timezone,
  );
  const queryEndEpochMs = parseQueryTimestamp(
    job.endTime,
    job.timeConfig.timezone,
  );
  const scopePrefixes = deriveManifestScopePrefixes(
    job,
    queryStartEpochMs,
    queryEndEpochMs,
  );
  const continuationToken = job.scanContinuationToken.trim();
  let scopeStartIndex = 0;
  let objectStartIndex = 0;

  if (continuationToken.startsWith("manifest:")) {
    const [, rawScopeIndex, rawObjectIndex] = continuationToken.split(":");
    scopeStartIndex = Math.max(0, Number(rawScopeIndex) || 0);
    objectStartIndex = Math.max(0, Number(rawObjectIndex) || 0);
  }

  for (
    let scopeIndex = scopeStartIndex;
    scopeIndex < scopePrefixes.length;
    scopeIndex += 1
  ) {
    if (isJobCancellationRequested(job.id)) {
      await flushMatches(job.id, pendingMatches);
      await flushProgress(job.id, progress);
      cancelJob(job.id);
      return;
    }

    const scopePrefix = scopePrefixes[scopeIndex];
    const objects = await loadManifestScopeObjects({
      reader,
      job,
      scopePrefix,
      queryStartEpochMs,
      queryEndEpochMs,
    });
    const startIndex = scopeIndex === scopeStartIndex ? objectStartIndex : 0;

    for (let objectIndex = startIndex; objectIndex < objects.length; objectIndex += 1) {
      const object = objects[objectIndex];

      if (!objectMatchesFilters(job, object.key)) {
        continue;
      }

      const rootPrefix = job.source.rootPrefix.trim();
      const relativePath = rootPrefix
        ? object.key.slice(rootPrefix.length)
        : object.key;

      await processObject({
        reader,
        job,
        objectKey: object.key,
        versionToken: object.versionToken,
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

      const latestJob = getJob(job.id);

      if (
        latestJob &&
        countJobResults(job.id) >= latestJob.requestedResultsCount
      ) {
        const nextScopeIndex =
          objectIndex + 1 >= objects.length ? scopeIndex + 1 : scopeIndex;
        const nextObjectIndex =
          objectIndex + 1 >= objects.length ? 0 : objectIndex + 1;
        pauseJob(job.id, `manifest:${nextScopeIndex}:${nextObjectIndex}`);
        return;
      }
    }

    objectStartIndex = 0;
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

async function updateWorkerHeartbeat() {
  await fs.mkdir(path.dirname(workerHeartbeatFile), { recursive: true });
  await fs.writeFile(workerHeartbeatFile, `${Date.now()}\n`);
}

async function main() {
  ensureRuntimeDirectories();
  initializeDatabase();
  await updateWorkerHeartbeat();

  const startupDetails = {
    db: getDatabaseFilePath(),
    cacheDir: getCacheDirectoryPath(),
    mode: "worker",
  };

  console.log("[waml-worker] started", startupDetails);
  console.log("[waml-worker] polling for search jobs");

  while (true) {
    const processed = await processNextJob();
    await updateWorkerHeartbeat();

    if (!processed) {
      await sleep(pollIntervalMs);
    }
  }
}

main().catch((error) => {
  console.error("[waml-worker] fatal", error);
  process.exitCode = 1;
});
