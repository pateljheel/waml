import { Storage } from "@google-cloud/storage";
import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import type { WorkerObjectStoreReader } from "./types";

type GcsListFilesApiResponse = {
  prefixes?: string[];
};

function createGcsStorageClient({
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

async function ensureGcsAuthConfig({
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

function formatGcsAuthError(error: unknown) {
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

export async function createGcsObjectStoreReader({
  gcpProject,
  authMode,
  serviceAccountKeyPath,
}: {
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}): Promise<WorkerObjectStoreReader> {
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
    async listObjectsPage({ bucket, prefix, continuationToken, maxKeys }) {
      try {
        const [files, nextQuery] = await client.bucket(bucket).getFiles({
          prefix: prefix.trim() || undefined,
          pageToken: continuationToken || undefined,
          maxResults: maxKeys,
          autoPaginate: false,
        });

        return {
          objects: files
            .map((file) => ({
              key: file.name,
              versionToken: String(
                file.metadata.generation ??
                  file.metadata.etag ??
                  `${file.metadata.updated ?? ""}:${file.metadata.size ?? ""}`,
              ),
              etag: file.metadata.etag ?? "",
              size: Number(file.metadata.size ?? "0"),
              lastModified: file.metadata.updated ?? "",
            }))
            .filter((entry) => Boolean(entry.key)),
          nextContinuationToken: nextQuery?.pageToken ?? null,
        };
      } catch (error) {
        throw new Error(formatGcsAuthError(error));
      }
    },

    async getObject({ bucket, key, abortSignal }) {
      try {
        const file = client.bucket(bucket).file(key);
        const [metadata] = await file.getMetadata();
        const stream = file.createReadStream();

        if (abortSignal) {
          const handleAbort = () => {
            stream.destroy(new Error("ABORT_ERR"));
          };

          if (abortSignal.aborted) {
            handleAbort();
          } else {
            abortSignal.addEventListener("abort", handleAbort, { once: true });
            stream.once("close", () => {
              abortSignal.removeEventListener("abort", handleAbort);
            });
            stream.once("error", () => {
              abortSignal.removeEventListener("abort", handleAbort);
            });
          }
        }

        return {
          body: stream as Readable,
          contentType: metadata.contentType ?? null,
        };
      } catch (error) {
        throw new Error(formatGcsAuthError(error));
      }
    },
  };
}
