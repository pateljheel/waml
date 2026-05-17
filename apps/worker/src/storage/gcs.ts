import { Storage } from "@google-cloud/storage";
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

export async function createGcsObjectStoreReader({
  gcpProject,
  authMode,
  serviceAccountKeyPath,
}: {
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
}): Promise<WorkerObjectStoreReader> {
  const client = createGcsStorageClient({
    gcpProject,
    authMode,
    serviceAccountKeyPath,
  });

  return {
    async listObjectsPage({ bucket, prefix, continuationToken, maxKeys }) {
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
    },

    async getObject({ bucket, key, abortSignal }) {
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
    },
  };
}
