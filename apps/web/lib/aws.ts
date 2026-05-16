import "server-only";

import {
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
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

export async function createS3Client(profile: string) {
  const configContent = await readIfPresent(configPath);
  const configSections = parseIniSections(configContent);
  const region = getProfileRegion(profile, configSections);

  return new S3Client({
    region,
    credentials: fromIni({ profile }),
  });
}

export async function listBucketsForProfile(profile: string) {
  const client = await createS3Client(profile);
  const response = await client.send(new ListBucketsCommand({}));
  return (response.Buckets ?? [])
    .map((bucket) => bucket.Name)
    .filter((name): name is string => Boolean(name))
    .sort((left, right) => left.localeCompare(right));
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
  const client = await createS3Client(profile);
  const normalizedPrefix = prefix.trim();

  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: normalizedPrefix,
      Delimiter: "/",
      ContinuationToken: continuationToken || undefined,
      MaxKeys: maxKeys,
    }),
  );

  return {
    normalizedPrefix,
    prefixes: (response.CommonPrefixes ?? [])
      .map((entry) => entry.Prefix)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right)),
    nextContinuationToken: response.NextContinuationToken ?? null,
    isTruncated: response.IsTruncated ?? false,
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

async function listAllChildrenForBucketLevel({
  client,
  bucket,
  prefix,
  maxKeys,
}: {
  client: S3Client;
  bucket: string;
  prefix: string;
  maxKeys: number;
}) {
  const collectedPrefixes: string[] = [];
  const collectedObjectKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: continuationToken,
        MaxKeys: maxKeys,
      }),
    );

    collectedPrefixes.push(
      ...(response.CommonPrefixes ?? [])
        .map((entry) => entry.Prefix)
        .filter((value): value is string => Boolean(value)),
    );

    collectedObjectKeys.push(
      ...(response.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((value): value is string => Boolean(value))
        .filter((value) => value !== prefix),
    );

    continuationToken = response.NextContinuationToken ?? undefined;
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
  maxDepth = 6,
  maxKeysPerLevel = 200,
  maxPrefixesToVisit = 500,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  maxDepth?: number;
  maxKeysPerLevel?: number;
  maxPrefixesToVisit?: number;
}) {
  const client = await createS3Client(profile);
  const normalizedRootPrefix = rootPrefix.trim();
  const relativePaths = new Set<string>();
  const queue: Array<{ prefix: string; depth: number }> = [
    { prefix: normalizedRootPrefix, depth: 0 },
  ];
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
      client,
      bucket,
      prefix: current.prefix,
      maxKeys: maxKeysPerLevel,
    });

    for (const childPrefix of childPrefixes) {
      visitedCount += 1;
      const relativePrefix = normalizedRootPrefix
        ? childPrefix.slice(normalizedRootPrefix.length)
        : childPrefix;
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

      if (relativeObjectKey) {
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
  const normalizedPattern = pathPattern.trim().replace(/^\/+|\/+$/g, "");
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

export async function searchPartitionValues({
  profile,
  bucket,
  rootPrefix,
  pathPattern,
  key,
  search,
  page,
  pageSize,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  pathPattern?: string;
  key: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { relativePrefixes } = await collectRelativePrefixes({
    profile,
    bucket,
    rootPrefix,
    maxDepth: 6,
    maxKeysPerLevel: 250,
    maxPrefixesToVisit: 1000,
  });

  const normalizedSearch = search.trim().toLowerCase();
  const trimmedPattern = pathPattern?.trim() ?? "";
  const uniqueValues = new Set<string>();
  let customMatched = false;

  for (const relativePath of relativePrefixes) {
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
  maxDepth = 6,
  maxKeysPerLevel = 200,
  maxPrefixesToVisit = 500,
}: {
  profile: string;
  bucket: string;
  rootPrefix: string;
  pathPattern?: string;
  maxDepth?: number;
  maxKeysPerLevel?: number;
  maxPrefixesToVisit?: number;
}) {
  const { normalizedRootPrefix, relativePrefixes } = await collectRelativePrefixes({
    profile,
    bucket,
    rootPrefix,
    maxDepth,
    maxKeysPerLevel,
    maxPrefixesToVisit,
  });

  const merged: PartitionDefinitionAccumulator = new Map();
  const hivePartitions = inferHivePartitionsFromPrefixes(relativePrefixes);
  const trimmedPattern = pathPattern?.trim() ?? "";
  const customPartitions = trimmedPattern
    ? inferCustomPartitionsFromPrefixes(relativePrefixes, trimmedPattern)
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
