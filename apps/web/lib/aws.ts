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

async function createS3Client(profile: string) {
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
