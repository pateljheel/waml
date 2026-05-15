import crypto from "node:crypto";
import path from "node:path";
import { getCacheDirectoryPath } from "@waml/db";
import type { SearchJob } from "@waml/shared";

const defaultCacheBudgetBytes = 512 * 1024 * 1024;
const cacheArtifactsDirectory = path.join(getCacheDirectoryPath(), "artifacts");

export function getCacheBudgetBytes() {
  const configured = Number(process.env.WAML_INDEX_CACHE_MAX_BYTES ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultCacheBudgetBytes;
}

export function createObjectCacheKey(
  bucket: string,
  objectKey: string,
  etag: string,
  chunkId = "0",
) {
  return crypto
    .createHash("sha256")
    .update(`${bucket}\n${objectKey}\n${etag}\n${chunkId}`)
    .digest("hex");
}

export function getObjectCachePaths(cacheKey: string) {
  const directory = path.join(cacheArtifactsDirectory, cacheKey.slice(0, 2));
  return {
    directory,
    textPath: path.join(directory, `${cacheKey}.txt`),
    trigramPath: path.join(directory, `${cacheKey}.trigrams.json`),
  };
}

export function buildPatternTrigrams(pattern: string) {
  const normalized = pattern.toLocaleLowerCase();
  const trigrams = new Set<string>();

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }

  return trigrams;
}

export function addTrigrams(target: Set<string>, text: string) {
  const normalized = text.toLocaleLowerCase();

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    target.add(normalized.slice(index, index + 3));
  }
}

export function shouldUseTrigramPrefilter(job: SearchJob) {
  return !job.searchOptions.caseSensitive && job.pattern.length >= 3;
}
