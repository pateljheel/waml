import { Storage } from "@google-cloud/storage";
import fs from "node:fs/promises";
import type { BrowserStorage } from "./types";

type GcsListFilesApiResponse = {
  prefixes?: string[];
};

export function createGcsStorageClient({
  gcpProject,
  authMode,
  serviceAccountKeyPath,
}: {
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}) {
  const projectId = gcpProject.trim() || undefined;

  if (authMode === "service_account") {
    return new Storage({
      projectId,
      keyFilename: serviceAccountKeyPath.trim() || undefined,
    });
  }

  return new Storage({
    projectId,
  });
}

export async function ensureGcsAuthConfig({
  authMode,
  serviceAccountKeyPath,
}: {
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}) {
  if (authMode !== "service_account") {
    return;
  }

  const normalizedPath = serviceAccountKeyPath.trim();

  if (!normalizedPath) {
    throw new Error(
      "GCS service account auth requires a service account key path.",
    );
  }

  try {
    await fs.access(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `GCS service account key file not found: ${normalizedPath}`,
      );
    }

    throw error;
  }
}

export function formatGcsAuthError(error: unknown) {
  if (!(error instanceof Error)) {
    return "GCS authentication failed.";
  }

  const message = error.message;

  if (
    message.includes("Could not load the default credentials") ||
    message.includes("Could not load the default credentials from any providers")
  ) {
    return "GCS ADC credentials not found. Run `gcloud auth application-default login` or configure `GOOGLE_APPLICATION_CREDENTIALS`.";
  }

  if (
    message.includes("service account key file not found") ||
    message.includes("requires a service account key path")
  ) {
    return message;
  }

  if (
    message.includes("permission") ||
    message.includes("Permission") ||
    message.includes("forbidden") ||
    message.includes("Forbidden") ||
    message.includes("Caller does not have storage")
  ) {
    return `GCS access denied: ${message}`;
  }

  return message;
}

export async function createGcsBrowserStorage({
  gcpProject,
  authMode,
  serviceAccountKeyPath,
}: {
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}): Promise<BrowserStorage> {
  await ensureGcsAuthConfig({
    authMode,
    serviceAccountKeyPath,
  });
  const client = createGcsStorageClient({
    gcpProject,
    authMode,
    serviceAccountKeyPath,
  });

  return {
    async listBuckets() {
      try {
        const [buckets] = await client.getBuckets();
        return buckets
          .map((bucket) => bucket.name)
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right));
      } catch (error) {
        throw new Error(formatGcsAuthError(error));
      }
    },

    async listObjects({
      bucket,
      prefix,
      delimiter,
      continuationToken,
      maxKeys,
    }) {
      try {
        const [files, nextQuery, apiResponse] = await client.bucket(bucket).getFiles({
          prefix: prefix.trim() || undefined,
          delimiter,
          pageToken: continuationToken || undefined,
          maxResults: maxKeys,
          autoPaginate: false,
          includeTrailingDelimiter: true,
        });

        const objectKeys = files
          .map((file) => file.name)
          .filter((value) => Boolean(value) && value !== prefix);

        const prefixes = Array.isArray((apiResponse as GcsListFilesApiResponse).prefixes)
          ? (apiResponse as GcsListFilesApiResponse).prefixes!.filter(
              (value): value is string => Boolean(value),
            )
          : [];

        return {
          objectKeys,
          commonPrefixes: prefixes,
          nextContinuationToken: nextQuery?.pageToken ?? null,
          isTruncated: Boolean(nextQuery?.pageToken),
        };
      } catch (error) {
        throw new Error(formatGcsAuthError(error));
      }
    },
  };
}
