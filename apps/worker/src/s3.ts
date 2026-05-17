import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type IniSectionMap = Record<string, Record<string, string>>;

const configPath = path.join(os.homedir(), ".aws", "config");

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

function createDynamicIniCredentialsProvider(profile: string) {
  return async () => {
    const provider = fromIni({ profile });
    const credentials = await provider();
    return {
      ...credentials,
    };
  };
}

export async function createS3Client(profile: string) {
  const configContent = await readIfPresent(configPath);
  const configSections = parseIniSections(configContent);
  const region = getProfileRegion(profile, configSections);

  return new S3Client({
    region,
    credentials: createDynamicIniCredentialsProvider(profile),
  });
}

function isRetryableCredentialError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    message?: string;
  };
  const code = candidate.name ?? candidate.Code ?? candidate.code ?? "";
  const message = candidate.message ?? "";

  return (
    code === "ExpiredToken" ||
    code === "InvalidAccessKeyId" ||
    code === "RequestExpired" ||
    code === "CredentialsProviderError" ||
    message.includes("ExpiredToken") ||
    message.includes("InvalidAccessKeyId") ||
    message.includes("The security token included in the request is expired")
  );
}

export async function sendWithCredentialRefresh<T>({
  clientRef,
  profile,
  operation,
}: {
  clientRef: { current: S3Client };
  profile: string;
  operation: (client: S3Client) => Promise<T>;
}) {
  try {
    return await operation(clientRef.current);
  } catch (error) {
    if (!isRetryableCredentialError(error)) {
      throw error;
    }

    clientRef.current = await createS3Client(profile);
    return operation(clientRef.current);
  }
}
