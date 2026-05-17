import crypto from "node:crypto";
import path from "node:path";
import { getCacheDirectoryPath } from "@waml/db";
import type { SearchJob } from "@waml/shared";
import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const defaultCacheBudgetBytes = 512 * 1024 * 1024;
const cacheArtifactsDirectory = path.join(getCacheDirectoryPath(), "artifacts");

export function getCacheBudgetBytes() {
  const configured = Number(process.env.WAML_INDEX_CACHE_MAX_BYTES ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultCacheBudgetBytes;
}

export function createObjectCacheKey(
  provider: SearchJob["source"]["provider"],
  bucket: string,
  objectKey: string,
  etag: string,
  chunkId = "0",
) {
  return crypto
    .createHash("sha256")
    .update(`${provider}\n${bucket}\n${objectKey}\n${etag}\n${chunkId}`)
    .digest("hex");
}

export function getObjectCachePaths(cacheKey: string) {
  const directory = path.join(cacheArtifactsDirectory, cacheKey.slice(0, 2));
  return {
    directory,
    textPath: path.join(directory, `${cacheKey}.txt.gz`),
    trigramPath: path.join(directory, `${cacheKey}.trigrams.bin`),
  };
}

function trigramToInt(trigram: string) {
  return (
    (trigram.charCodeAt(0) << 16) |
    (trigram.charCodeAt(1) << 8) |
    trigram.charCodeAt(2)
  ) >>> 0;
}

export function buildPatternTrigrams(pattern: string) {
  const normalized = pattern.toLocaleLowerCase();
  const trigrams = new Set<number>();

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(trigramToInt(normalized.slice(index, index + 3)));
  }

  return trigrams;
}

export function addTrigrams(target: Set<number>, text: string) {
  const normalized = text.toLocaleLowerCase();

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    target.add(trigramToInt(normalized.slice(index, index + 3)));
  }
}

export function shouldUseTrigramPrefilter(job: SearchJob) {
  return !job.searchOptions.caseSensitive && job.pattern.length >= 3;
}

export function writeCompressedTextArtifact(filepath: string, text: string) {
  return fs.writeFile(filepath, gzipSync(Buffer.from(text, "utf8")));
}

export async function readCompressedTextArtifact(filepath: string) {
  const compressed = await fs.readFile(filepath);

  if (compressed.length >= 2 && compressed[0] === 0x1f && compressed[1] === 0x8b) {
    return gunzipSync(compressed).toString("utf8");
  }

  // Backward compatibility for pre-compression cache entries.
  return compressed.toString("utf8");
}

export function writePackedTrigramArtifact(filepath: string, trigrams: Set<number>) {
  const values = [...trigrams.values()].sort((left, right) => left - right);
  const buffer = Buffer.allocUnsafe(values.length * 4);

  values.forEach((value, index) => {
    buffer.writeUInt32BE(value >>> 0, index * 4);
  });

  return fs.writeFile(filepath, buffer);
}

export async function packedTrigramArtifactContainsAll(
  filepath: string,
  patternTrigrams: Iterable<number>,
) {
  const buffer = await fs.readFile(filepath);

  for (const patternTrigram of patternTrigrams) {
    let low = 0;
    let high = buffer.length / 4 - 1;
    let found = false;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const value = buffer.readUInt32BE(middle * 4);

      if (value === patternTrigram) {
        found = true;
        break;
      }

      if (value < patternTrigram) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (!found) {
      return false;
    }
  }

  return true;
}
