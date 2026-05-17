import "server-only";

import type { PrefixFilters } from "@waml/shared";
import { normalizePrefixFilters } from "@waml/shared";
import { createBrowserStorage, type BrowserStorage } from "./storage";
export { createS3Client } from "./storage/s3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type IniSectionMap = Record<string, Record<string, string>>;
type FilterKind = "category" | "range";
type InferredPartition = {
  key: string;
  values: string[];
  kind: FilterKind;
  source: "hive" | "custom";
  level: number;
  order: number;
};
const inferredValueSampleLimit = 20;

const configPath = path.join(os.homedir(), ".aws", "config");
const credentialsPath = path.join(os.homedir(), ".aws", "credentials");

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

export async function listAwsProfiles() {
  const [configContent, credentialsContent] = await Promise.all([
    readIfPresent(configPath),
    readIfPresent(credentialsPath),
  ]);

  const configSections = parseIniSections(configContent);
  const credentialSections = parseIniSections(credentialsContent);

  const profileNames = new Set<string>();

  for (const sectionName of Object.keys(configSections)) {
    profileNames.add(sectionName.replace(/^profile\s+/, ""));
  }

  for (const sectionName of Object.keys(credentialSections)) {
    profileNames.add(sectionName);
  }

  return [...profileNames].sort((left, right) => left.localeCompare(right));
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

async function createStorageForProfile(profile: string) {
  return createBrowserStorage({
    provider: "s3",
    awsProfile: profile,
  });
}

export async function listBucketsForProfile(profile: string) {
  const storage = await createStorageForProfile(profile);
  return storage.listBuckets();
}

export async function searchBucketsForProfile({
  profile,
  search,
  page,
  pageSize,
}: {
  profile: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const buckets = await listBucketsForProfile(profile);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredBuckets = normalizedSearch
    ? buckets.filter((bucket) => bucket.toLowerCase().includes(normalizedSearch))
    : buckets;

  const total = filteredBuckets.length;
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * safePageSize;

  return {
    buckets: filteredBuckets.slice(startIndex, startIndex + safePageSize),
    search: normalizedSearch,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages,
  };
}

export async function listPrefixesForBucket({
  profile,
  bucket,
  prefix,
  continuationToken,
  maxKeys,
}: {
  profile: string;
  bucket: string;
  prefix: string;
  continuationToken?: string;
  maxKeys: number;
}) {
  const storage = await createStorageForProfile(profile);
  const normalizedPrefix = prefix.trim();
  const response = await storage.listObjects({
    bucket,
    prefix: normalizedPrefix,
    delimiter: "/",
    continuationToken,
    maxKeys,
  });

  return {
    normalizedPrefix,
    prefixes: [...response.commonPrefixes].sort((left, right) =>
      left.localeCompare(right),
    ),
    nextContinuationToken: response.nextContinuationToken,
    isTruncated: response.isTruncated,
  };
}

type PartitionAccumulator = Map<string, Set<string>>;
type PartitionDefinitionAccumulator = Map<
  string,
  {
    kind: FilterKind;
    source: "hive" | "custom";
    level: number;
    order: number;
    values: Set<string>;
  }
>;
const maxDerivedDiscoveryPrefixes = 16;

async function listAllChildrenForBucketLevel({
  storage,
  bucket,
  prefix,
  maxKeys,
}: {
  storage: BrowserStorage;
  bucket: string;
  prefix: string;
  maxKeys: number;
}) {
  const collectedPrefixes: string[] = [];
  const collectedObjectKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await storage.listObjects({
      bucket,
      prefix,
      delimiter: "/",
      continuationToken,
      maxKeys,
    });

    collectedPrefixes.push(
      ...response.commonPrefixes,
    );

    collectedObjectKeys.push(
      ...response.objectKeys.filter((value) => value !== prefix),
    );

    continuationToken = response.nextContinuationToken ?? undefined;
  } while (continuationToken);

  return {
    prefixes: collectedPrefixes.sort((left, right) => left.localeCompare(right)),
    objectKeys: collectedObjectKeys.sort((left, right) => left.localeCompare(right)),
  };
}

async function collectRelativePrefixes({
  profile,
  bucket,
  rootPrefix,
  pathPattern,
  selectedFilters,
  ignoreFilterKey,
  maxDepth = 6,
  maxKeysPerLevel = 200,
  maxPrefixesToVisit = 500,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  pathPattern?: string;
  selectedFilters?: PrefixFilters;
  ignoreFilterKey?: string;
  maxDepth?: number;
  maxKeysPerLevel?: number;
  maxPrefixesToVisit?: number;
}) {
  const storage = await createStorageForProfile(profile);
  const normalizedRootPrefix = rootPrefix.trim();
  const relativePaths = new Set<string>();
  const queue: Array<{ prefix: string; depth: number }> = deriveDiscoveryPrefixes({
    rootPrefix: normalizedRootPrefix,
    pathPattern,
    selectedFilters: selectedFilters ?? {},
    ignoreFilterKey,
  }).map((prefix) => ({ prefix, depth: 0 }));
  let visitedCount = 0;

  while (queue.length > 0 && visitedCount < maxPrefixesToVisit) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const { prefixes: childPrefixes, objectKeys } = await listAllChildrenForBucketLevel({
      storage,
      bucket,
      prefix: current.prefix,
      maxKeys: maxKeysPerLevel,
    });

    for (const childPrefix of childPrefixes) {
      visitedCount += 1;
      const relativePrefix = normalizedRootPrefix
        ? childPrefix.slice(normalizedRootPrefix.length)
        : childPrefix;

      if (
        pathPattern &&
        !canRelativePathMatchPatternPrefix(relativePrefix, pathPattern)
      ) {
        continue;
      }

      relativePaths.add(relativePrefix);

      queue.push({ prefix: childPrefix, depth: current.depth + 1 });

      if (visitedCount >= maxPrefixesToVisit) {
        break;
      }
    }

    for (const objectKey of objectKeys) {
      const relativeObjectKey = normalizedRootPrefix
        ? objectKey.slice(normalizedRootPrefix.length)
        : objectKey;

      if (
        relativeObjectKey &&
        (!pathPattern ||
          canRelativePathMatchPatternPrefix(relativeObjectKey, pathPattern))
      ) {
        relativePaths.add(relativeObjectKey);
      }
    }
  }

  return {
    normalizedRootPrefix,
    relativePrefixes: [...relativePaths].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathPattern(pathPattern?: string) {
  return (pathPattern ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function getExactFilterValues(
  selectedFilters: PrefixFilters,
  ignoreKey?: string,
) {
  return Object.fromEntries(
    Object.entries(selectedFilters)
      .flatMap(([key, filter]) => {
        if (
          key === ignoreKey ||
          filter.mode !== "values" ||
          filter.values.length === 0
        ) {
          return [];
        }

        return [[key, [...filter.values]]];
      }),
  ) as Record<string, string[]>;
}

function inferHivePartitionsFromPrefixes(relativePrefixes: string[]) {
  const accumulator = new Map<
    string,
    { values: string[]; seen: Set<string>; level: number; order: number }
  >();

  for (const relativePrefix of relativePrefixes) {
    const segments = relativePrefix.split("/").filter(Boolean);

    for (const [index, segment] of segments.entries()) {
      const hiveMatch = segment.match(/^([^=\/]+)=(.+)$/);

      if (!hiveMatch) {
        continue;
      }

      const [, key, value] = hiveMatch;
      const current = accumulator.get(key) ?? {
        values: [],
        seen: new Set<string>(),
        level: index,
        order: index,
      };
      if (
        !current.seen.has(value) &&
        current.values.length < inferredValueSampleLimit
      ) {
        current.seen.add(value);
        current.values.push(value);
      }
      current.level = Math.min(current.level, index);
      current.order = Math.min(current.order, index);
      accumulator.set(key, current);
    }
  }

  return [...accumulator.entries()].map(([key, definition]) => ({
    key,
    values: [...definition.values].sort((left, right) => left.localeCompare(right)),
    kind: "category" as const,
    source: "hive" as const,
    level: definition.level,
    order: definition.order,
  }));
}

function compileCustomPathPattern(pathPattern: string) {
  const normalizedPattern = normalizePathPattern(pathPattern);
  const capturePattern = /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const captures: Array<{ kind: FilterKind; key: string }> = [];
  let regexSource = "^";
  let lastIndex = 0;

  for (const match of normalizedPattern.matchAll(capturePattern)) {
    const [fullMatch, kind, key] = match;
    const matchIndex = match.index ?? 0;
    regexSource += escapeRegExp(normalizedPattern.slice(lastIndex, matchIndex));
    regexSource += "([^/]+)";
    captures.push({ kind: kind as FilterKind, key });
    lastIndex = matchIndex + fullMatch.length;
  }

  regexSource += escapeRegExp(normalizedPattern.slice(lastIndex));
  regexSource += "/?$";

  return {
    regex: new RegExp(regexSource),
    captures,
    normalizedPattern,
  };
}

function buildCustomPatternSegmentRegexes(pathPattern: string) {
  const normalizedPattern = normalizePathPattern(pathPattern);

  if (!normalizedPattern) {
    return [];
  }

  return normalizedPattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const regexSource = segment.replace(
        /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g,
        "[^/]+",
      );
      return new RegExp(`^${regexSource}$`);
    });
}

function canRelativePathMatchPatternPrefix(relativePath: string, pathPattern: string) {
  const segmentRegexes = buildCustomPatternSegmentRegexes(pathPattern);

  if (segmentRegexes.length === 0) {
    return true;
  }

  const segments = relativePath.replace(/\/+$/, "").split("/").filter(Boolean);

  if (segments.length > segmentRegexes.length) {
    return false;
  }

  return segments.every((segment, index) => segmentRegexes[index]?.test(segment));
}

function deriveDiscoveryPrefixes({
  rootPrefix,
  pathPattern,
  selectedFilters,
  ignoreFilterKey,
}: {
  rootPrefix: string;
  pathPattern?: string;
  selectedFilters: PrefixFilters;
  ignoreFilterKey?: string;
}) {
  const normalizedRootPrefix = rootPrefix.trim();
  const normalizedPattern = normalizePathPattern(pathPattern);

  if (!normalizedPattern) {
    return [normalizedRootPrefix];
  }

  const exactFilterValues = getExactFilterValues(selectedFilters, ignoreFilterKey);
  const patternSegments = normalizedPattern.split("/").filter(Boolean);
  let prefixes = [normalizedRootPrefix];

  for (const segment of patternSegments) {
    const capturePattern = /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
    const segmentVariants = [""];
    let lastIndex = 0;
    let unresolved = false;

    for (const match of segment.matchAll(capturePattern)) {
      const [fullMatch, , key] = match;
      const matchIndex = match.index ?? 0;
      const literal = segment.slice(lastIndex, matchIndex);

      for (let index = 0; index < segmentVariants.length; index += 1) {
        segmentVariants[index] += literal;
      }

      const values = exactFilterValues[key] ?? [];

      if (values.length === 0) {
        unresolved = true;
        break;
      }

      const nextVariants: string[] = [];

      for (const variant of segmentVariants) {
        for (const value of values) {
          nextVariants.push(`${variant}${value}`);

          if (nextVariants.length >= maxDerivedDiscoveryPrefixes) {
            break;
          }
        }

        if (nextVariants.length >= maxDerivedDiscoveryPrefixes) {
          break;
        }
      }

      segmentVariants.splice(0, segmentVariants.length, ...nextVariants);
      lastIndex = matchIndex + fullMatch.length;
    }

    if (segmentVariants.length === 0) {
      return [normalizedRootPrefix];
    }

    if (unresolved) {
      return [
        ...new Set(
          prefixes.flatMap((prefix) =>
            segmentVariants.map((variant) => `${prefix}${variant}`),
          ),
        ),
      ];
    }

    const trailingLiteral = segment.slice(lastIndex);
    prefixes = [
      ...new Set(
        prefixes.flatMap((prefix) =>
          segmentVariants.map((variant) => `${prefix}${variant}${trailingLiteral}/`),
        ),
      ),
    ].slice(0, maxDerivedDiscoveryPrefixes);
  }

  return prefixes.length > 0 ? prefixes : [normalizedRootPrefix];
}

function inferCustomPartitionsFromPrefixes(
  relativePrefixes: string[],
  pathPattern: string,
) {
  const compiled = compileCustomPathPattern(pathPattern);

  if (compiled.captures.length === 0) {
    return [] as InferredPartition[];
  }

  const accumulator: PartitionDefinitionAccumulator = new Map();
  const captureMetadata = compiled.captures.map((capture, index) => {
    const token = `{${capture.kind}:${capture.key}}`;
    const tokenIndex = compiled.normalizedPattern.indexOf(token);
    const before = tokenIndex >= 0 ? compiled.normalizedPattern.slice(0, tokenIndex) : "";
    return {
      level: before.split("/").filter(Boolean).length,
      order: index,
    };
  });

  for (const relativePrefix of relativePrefixes) {
    const normalizedRelativePrefix = relativePrefix.replace(/\/+$/, "");
    const match = normalizedRelativePrefix.match(compiled.regex);

    if (!match) {
      continue;
    }

    compiled.captures.forEach((capture, index) => {
      const value = match[index + 1];

      if (!value) {
        return;
      }

      const current = accumulator.get(capture.key) ?? {
        kind: capture.kind,
        source: "custom" as const,
        level: captureMetadata[index]?.level ?? 0,
        order: captureMetadata[index]?.order ?? index,
        values: new Set<string>(),
      };

      current.values.add(value);
      current.level = Math.min(current.level, captureMetadata[index]?.level ?? 0);
      current.order = Math.min(current.order, captureMetadata[index]?.order ?? index);
      accumulator.set(capture.key, current);
    });
  }

  return [...accumulator.entries()].map(([key, definition]) => ({
    key,
    values: [...definition.values].sort((left, right) =>
      left.localeCompare(right),
    ),
    kind: definition.kind,
    source: definition.source,
    level: definition.level,
    order: definition.order,
  }));
}

function extractHivePartitionValue(relativePath: string, key: string) {
  const segments = relativePath.split("/").filter(Boolean);

  for (const segment of segments) {
    const hiveMatch = segment.match(/^([^=\/]+)=(.+)$/);

    if (hiveMatch && hiveMatch[1] === key) {
      return hiveMatch[2];
    }
  }

  return null;
}

function extractCustomPartitionValue(
  relativePath: string,
  pathPattern: string,
  key: string,
) {
  const compiled = compileCustomPathPattern(pathPattern);

  if (!compiled.captures.some((capture) => capture.key === key)) {
    return null;
  }

  const normalizedRelativePath = relativePath.replace(/\/+$/, "");
  const match = normalizedRelativePath.match(compiled.regex);

  if (!match) {
    return null;
  }

  const captureIndex = compiled.captures.findIndex((capture) => capture.key === key);
  return captureIndex >= 0 ? match[captureIndex + 1] ?? null : null;
}

function extractPartitionValue(
  relativePath: string,
  key: string,
  pathPattern?: string,
) {
  const trimmedPattern = pathPattern?.trim() ?? "";

  if (trimmedPattern) {
    return extractCustomPartitionValue(relativePath, trimmedPattern, key);
  }

  return extractHivePartitionValue(relativePath, key);
}

function partitionValueMatchesFilter(
  value: string | null,
  filter: PrefixFilters[string],
) {
  if (!value) {
    return false;
  }

  if (filter.mode === "values") {
    return filter.values.includes(value);
  }

  const startsAfter = !filter.start || value >= filter.start;
  const endsBefore = !filter.end || value <= filter.end;
  return startsAfter && endsBefore;
}

function pathMatchesSelectedFilters(
  relativePath: string,
  pathPattern: string | undefined,
  selectedFilters: PrefixFilters,
  ignoreKey?: string,
) {
  return Object.entries(selectedFilters).every(([key, filter]) => {
    if (key === ignoreKey) {
      return true;
    }

    return partitionValueMatchesFilter(
      extractPartitionValue(relativePath, key, pathPattern),
      filter,
    );
  });
}

export async function searchPartitionValues({
  profile,
  bucket,
  rootPrefix,
  pathPattern,
  key,
  search,
  selectedFilters,
  page,
  pageSize,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  pathPattern?: string;
  key: string;
  search: string;
  selectedFilters?: PrefixFilters;
  page: number;
  pageSize: number;
}) {
  const normalizedSelectedFilters = normalizePrefixFilters(selectedFilters);
  const { relativePrefixes } = await collectRelativePrefixes({
    profile,
    bucket,
    rootPrefix,
    pathPattern,
    selectedFilters: normalizedSelectedFilters,
    ignoreFilterKey: key,
    maxDepth: 6,
    maxKeysPerLevel: 250,
    maxPrefixesToVisit: 1000,
  });

  const normalizedSearch = search.trim().toLowerCase();
  const trimmedPattern = pathPattern?.trim() ?? "";
  const uniqueValues = new Set<string>();
  let customMatched = false;

  for (const relativePath of relativePrefixes) {
    if (
      !pathMatchesSelectedFilters(
        relativePath,
        trimmedPattern,
        normalizedSelectedFilters,
        key,
      )
    ) {
      continue;
    }

    let value: string | null = null;

    if (trimmedPattern) {
      value = extractCustomPartitionValue(relativePath, trimmedPattern, key);
      if (value !== null) {
        customMatched = true;
      }
    }

    if (value === null && !customMatched) {
      value = extractHivePartitionValue(relativePath, key);
    }

    if (!value) {
      continue;
    }

    if (
      normalizedSearch &&
      !value.toLowerCase().includes(normalizedSearch)
    ) {
      continue;
    }

    uniqueValues.add(value);
  }

  const values = [...uniqueValues].sort((left, right) => left.localeCompare(right));
  const safePageSize = Math.max(1, pageSize);
  const total = values.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * safePageSize;

  return {
    key,
    values: values.slice(startIndex, startIndex + safePageSize),
    search: normalizedSearch,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages,
  };
}

export async function inferPartitions({
  profile,
  bucket,
  rootPrefix,
  pathPattern,
  selectedFilters,
  maxDepth = 6,
  maxKeysPerLevel = 200,
  maxPrefixesToVisit = 500,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  pathPattern?: string;
  selectedFilters?: PrefixFilters;
  maxDepth?: number;
  maxKeysPerLevel?: number;
  maxPrefixesToVisit?: number;
}) {
  const normalizedSelectedFilters = normalizePrefixFilters(selectedFilters);
  const { normalizedRootPrefix, relativePrefixes } = await collectRelativePrefixes({
    profile,
    bucket,
    rootPrefix,
    pathPattern,
    selectedFilters: normalizedSelectedFilters,
    maxDepth,
    maxKeysPerLevel,
    maxPrefixesToVisit,
  });
  const scopedRelativePrefixes = relativePrefixes.filter((relativePath) =>
    pathMatchesSelectedFilters(
      relativePath,
      pathPattern,
      normalizedSelectedFilters,
    ),
  );

  const merged: PartitionDefinitionAccumulator = new Map();
  const hivePartitions = inferHivePartitionsFromPrefixes(scopedRelativePrefixes);
  const trimmedPattern = pathPattern?.trim() ?? "";
  const customPartitions = trimmedPattern
    ? inferCustomPartitionsFromPrefixes(scopedRelativePrefixes, trimmedPattern)
    : [];

  const basePartitions =
    trimmedPattern && customPartitions.length > 0 ? customPartitions : hivePartitions;

  for (const partition of basePartitions) {
    merged.set(partition.key, {
      kind: partition.kind,
      source: partition.source,
      level: partition.level,
      order: partition.order,
      values: new Set(partition.values),
    });
  }

  return {
    rootPrefix: normalizedRootPrefix,
    pathPattern: trimmedPattern,
    partitions: [...merged.entries()]
      .map(([key, definition]) => ({
        key,
        values: [...definition.values].sort((left, right) =>
          left.localeCompare(right),
        ),
        kind: definition.kind,
        source: definition.source,
        level: definition.level,
        order: definition.order,
      }))
      .sort((left, right) =>
        left.level === right.level
          ? left.order === right.order
            ? left.key.localeCompare(right.key)
            : left.order - right.order
          : left.level - right.level,
      ),
  };
}
