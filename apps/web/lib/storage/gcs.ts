import { Storage } from "@google-cloud/storage";
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

export async function createGcsBrowserStorage({
  gcpProject,
  authMode,
  serviceAccountKeyPath,
}: {
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}): Promise<BrowserStorage> {
  const client = createGcsStorageClient({
    gcpProject,
    authMode,
    serviceAccountKeyPath,
  });

  return {
    async listBuckets() {
      const [buckets] = await client.getBuckets();
      return buckets
        .map((bucket) => bucket.name)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
    },

    async listObjects({
      bucket,
      prefix,
      delimiter,
      continuationToken,
      maxKeys,
    }) {
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
    },
  };
}
