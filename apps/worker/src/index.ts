import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  appendJobEvent,
  cancelJob,
  claimNextQueuedJob,
  completeJob,
  ensureRuntimeDirectories,
  failJob,
  getCacheDirectoryPath,
  getDatabaseFilePath,
  getJob,
  initializeDatabase,
  isJobCancellationRequested,
  updateJobProgress,
} from "@waml/db";
import {
  deriveCoarseTimeRangeFromMappings,
  doesRangeOverlap,
  extractLineTimestamp,
  isTimestampInRange,
  normalizePrefixFilters,
  parseQueryTimestamp,
} from "@waml/shared";
import type { SearchJob, SearchMatch } from "@waml/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

type IniSectionMap = Record<string, Record<string, string>>;

const configPath = path.join(os.homedir(), ".aws", "config");
const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
const pollIntervalMs = 600;
const progressIntervalMs = 500;
const matchFlushIntervalMs = 250;
const matchFlushSize = 50;
const binarySniffBytes = 4096;
const binaryExtensions = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".so",
  ".tar",
  ".tgz",
  ".war",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function readIfPresent(filepath: string) {
  try {
    return await fs.readFile(filepath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function parseIniSections(content: string) {
  const sections: IniSectionMap = {};
  let currentSection: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] = sections[currentSection] ?? {};
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    sections[currentSection][key] = value;
  }

  return sections;
}

function getProfileRegion(profile: string, configSections: IniSectionMap) {
  const namedSection = configSections[`profile ${profile}`];
  const directSection = configSections[profile];

  return (
    namedSection?.region ??
    directSection?.region ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    "us-east-1"
  );
}

async function createS3Client(profile: string) {
  const configContent = await readIfPresent(configPath);
  const configSections = parseIniSections(configContent);
  const region = getProfileRegion(profile, configSections);

  return new S3Client({
    region,
    credentials: fromIni({ profile }),
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHiveValues(relativePath: string) {
  const values: Record<string, string> = {};
  const segments = relativePath.split("/").filter(Boolean);

  for (const segment of segments) {
    const match = segment.match(/^([^=\/]+)=(.+)$/);

    if (match) {
      values[match[1]] = match[2];
    }
  }

  return values;
}

function compileCustomPathPattern(pathPattern: string) {
  const normalizedPattern = pathPattern.trim().replace(/^\/+|\/+$/g, "");
  const capturePattern = /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const captures: Array<{ key: string }> = [];
  let regexSource = "^";
  let lastIndex = 0;

  for (const match of normalizedPattern.matchAll(capturePattern)) {
    const [fullMatch, , key] = match;
    const matchIndex = match.index ?? 0;
    regexSource += escapeRegExp(normalizedPattern.slice(lastIndex, matchIndex));
    regexSource += "([^/]+)";
    captures.push({ key });
    lastIndex = matchIndex + fullMatch.length;
  }

  regexSource += escapeRegExp(normalizedPattern.slice(lastIndex));
  regexSource += "/?$";

  return {
    regex: new RegExp(regexSource),
    captures,
  };
}

function extractCustomValues(relativePath: string, pathPattern: string) {
  const trimmedPattern = pathPattern.trim();

  if (!trimmedPattern) {
    return null;
  }

  const compiled = compileCustomPathPattern(trimmedPattern);
  const match = relativePath.replace(/\/+$/, "").match(compiled.regex);

  if (!match) {
    return null;
  }

  const values: Record<string, string> = {};

  compiled.captures.forEach((capture, index) => {
    const value = match[index + 1];

    if (value) {
      values[capture.key] = value;
    }
  });

  return values;
}

function parseComparableNumber(value: string) {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseComparableTimestamp(value: string) {
  const trimmed = value.trim();

  if (/^\d{6}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    return Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  }

  if (/^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  }

  if (/^\d{10}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    const hour = Number(trimmed.slice(8, 10));
    return Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed.replace(" ", "T") + "Z");
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      trimmed,
    )
  ) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function compareRangeValues(left: string, right: string) {
  const leftNumber = parseComparableNumber(left);
  const rightNumber = parseComparableNumber(right);

  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }

  const leftTimestamp = parseComparableTimestamp(left);
  const rightTimestamp = parseComparableTimestamp(right);

  if (leftTimestamp !== null && rightTimestamp !== null) {
    return leftTimestamp - rightTimestamp;
  }

  return left.localeCompare(right);
}

function objectMatchesFilters(job: SearchJob, objectKey: string) {
  const rootPrefix = job.source.rootPrefix.trim();
  const relativePath = rootPrefix ? objectKey.slice(rootPrefix.length) : objectKey;
  const filterEntries = Object.entries(normalizePrefixFilters(job.prefixFilters));

  if (filterEntries.length === 0) {
    return true;
  }

  const customValues = extractCustomValues(relativePath, job.customPathPattern);
  const values = customValues ?? extractHiveValues(relativePath);

  return filterEntries.every(([key, filter]) => {
    const objectValue = values[key];

    if (!objectValue) {
      return false;
    }

    if (filter.mode === "values") {
      return filter.values.includes(objectValue);
    }

    if (filter.start && compareRangeValues(objectValue, filter.start) < 0) {
      return false;
    }

    if (filter.end && compareRangeValues(objectValue, filter.end) > 0) {
      return false;
    }

    return true;
  });
}

function shouldSkipObjectByKey(objectKey: string) {
  const lowerKey = objectKey.toLocaleLowerCase();

  for (const extension of binaryExtensions) {
    if (lowerKey.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function isGzipObject(objectKey: string) {
  return objectKey.toLocaleLowerCase().endsWith(".gz");
}

function looksBinaryBuffer(chunkBuffer: Buffer) {
  const sample = chunkBuffer.subarray(0, binarySniffBytes);

  if (sample.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    const isExtendedUtf8Byte = byte >= 128;

    if (!isAllowedControl && !isPrintableAscii && !isExtendedUtf8Byte) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.2;
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
  client,
  job,
  objectKey,
  relativePath,
  progress,
  pendingMatches,
  lastProgressAt,
  lastMatchAt,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  client: S3Client;
  job: SearchJob;
  objectKey: string;
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
  const partitionValues =
    extractCustomValues(relativePath, job.customPathPattern) ??
    extractHiveValues(relativePath);
  const coarseTimeRange = deriveCoarseTimeRangeFromMappings(
    job.timeConfig.pathMappings,
    partitionValues,
    job.timeConfig.timezone,
  ).range;

  if (!gzipObject && shouldSkipObjectByKey(objectKey)) {
    appendJobEvent(job.id, "object.skipped", {
      objectKey,
      reason: "binary_extension",
    });
    return;
  }

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

  const controller = new AbortController();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: job.source.bucket,
      Key: objectKey,
    }),
    {
      abortSignal: controller.signal,
    },
  );

  const body = response.Body as AsyncIterable<Uint8Array | Buffer | string> | undefined;

  if (!body) {
    return;
  }

  const sourceStream: Readable =
    typeof (body as NodeJS.ReadableStream).pipe === "function"
      ? (body as Readable)
      : Readable.from(body);
  const decodedBody: Readable = gzipObject
    ? sourceStream.pipe(createGunzip())
    : sourceStream;

  appendJobEvent(job.id, "object.started", { objectKey });
  appendJobEvent(job.id, "chunk.started", { objectKey, chunkId: "0" });

  progress.objectsScanned += 1;
  progress.chunksScanned += 1;

  const decoder = new TextDecoder("utf-8");
  let bufferedText = "";
  let lineNumber = 0;
  let inspectedFirstChunk = false;

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
        (queryStartEpochMs !== null || queryEndEpochMs !== null) &&
        job.timeConfig.lineParser.mode !== "none" &&
        (parsedLineTimestamp === null ||
          !isTimestampInRange(
            parsedLineTimestamp,
            queryStartEpochMs,
            queryEndEpochMs,
          ))
      ) {
        return;
      }

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

async function runSearchJob(job: SearchJob) {
  const client = await createS3Client(job.source.awsProfile);
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

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: job.source.bucket,
        Prefix: job.source.rootPrefix.trim() || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 250,
      }),
    );

    const objectKeys = (response.Contents ?? [])
      .map((entry: { Key?: string }) => entry.Key)
      .filter((value): value is string => Boolean(value))
      .filter((value) => value !== job.source.rootPrefix);

    for (const objectKey of objectKeys) {
      if (!objectMatchesFilters(job, objectKey)) {
        continue;
      }

      const rootPrefix = job.source.rootPrefix.trim();
      const relativePath = rootPrefix ? objectKey.slice(rootPrefix.length) : objectKey;

      await processObject({
        client,
        job,
        objectKey,
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
