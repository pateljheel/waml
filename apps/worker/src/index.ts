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
import type { SearchJob, SearchMatch } from "@waml/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type IniSectionMap = Record<string, Record<string, string>>;

const configPath = path.join(os.homedir(), ".aws", "config");
const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
const pollIntervalMs = 600;
const progressIntervalMs = 500;
const matchFlushIntervalMs = 250;
const matchFlushSize = 50;

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

function objectMatchesFilters(job: SearchJob, objectKey: string) {
  const rootPrefix = job.source.rootPrefix.trim();
  const relativePath = rootPrefix ? objectKey.slice(rootPrefix.length) : objectKey;
  const filterEntries = Object.entries(job.prefixFilters ?? {});

  if (filterEntries.length === 0) {
    return true;
  }

  const customValues = extractCustomValues(relativePath, job.customPathPattern);
  const values = customValues ?? extractHiveValues(relativePath);

  return filterEntries.every(([key, value]) => values[key] === value);
}

function extractTimestamp(lineText: string) {
  const match = lineText.match(
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/,
  );

  return match?.[1];
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
  progress,
  pendingMatches,
  lastProgressAt,
  lastMatchAt,
}: {
  client: S3Client;
  job: SearchJob;
  objectKey: string;
  progress: SearchJob["progress"];
  pendingMatches: SearchMatch[];
  lastProgressAt: { value: number };
  lastMatchAt: { value: number };
}) {
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

  appendJobEvent(job.id, "object.started", { objectKey });
  appendJobEvent(job.id, "chunk.started", { objectKey, chunkId: "0" });

  progress.objectsScanned += 1;
  progress.chunksScanned += 1;

  const decoder = new TextDecoder("utf-8");
  let bufferedText = "";
  let lineNumber = 0;

  for await (const rawChunk of body) {
    if (isJobCancellationRequested(job.id)) {
      controller.abort();
      throw new Error("JOB_CANCELLED");
    }

    const chunkBuffer =
      typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);

    progress.bytesScanned += chunkBuffer.byteLength;
    bufferedText += decoder.decode(chunkBuffer, { stream: true });

    const lines = bufferedText.split(/\r?\n/);
    bufferedText = lines.pop() ?? "";

    for (const lineText of lines) {
      lineNumber += 1;

      if (!lineText.includes(job.pattern)) {
        continue;
      }

      pendingMatches.push({
        objectKey,
        lineNumber,
        lineText,
        timestampText: extractTimestamp(lineText),
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

    if (bufferedText.includes(job.pattern)) {
      pendingMatches.push({
        objectKey,
        lineNumber,
        lineText: bufferedText,
        timestampText: extractTimestamp(bufferedText),
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

      await processObject({
        client,
        job,
        objectKey,
        progress,
        pendingMatches,
        lastProgressAt,
        lastMatchAt,
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
