import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { createS3Client, sendWithCredentialRefresh } from "../s3";
import type { WorkerObjectStoreReader } from "./types";

export async function createS3ObjectStoreReader(
  profile: string,
): Promise<WorkerObjectStoreReader> {
  const clientRef = {
    current: await createS3Client(profile),
  };

  return {
    async listObjectsPage({ bucket, prefix, continuationToken, maxKeys }) {
      const response = await sendWithCredentialRefresh({
        clientRef,
        profile,
        operation: (client: S3Client) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix.trim() || undefined,
              ContinuationToken: continuationToken,
              MaxKeys: maxKeys,
            }),
          ),
      });

      return {
        objects: (response.Contents ?? [])
          .filter((entry) => Boolean(entry.Key))
          .map((entry) => ({
            key: entry.Key!,
            etag: entry.ETag?.replaceAll('"', "") ?? "",
            size: entry.Size ?? 0,
            lastModified: entry.LastModified?.toISOString() ?? "",
          })),
        nextContinuationToken: response.NextContinuationToken ?? null,
      };
    },

    async getObject({ bucket, key, abortSignal }) {
      const response = await sendWithCredentialRefresh({
        clientRef,
        profile,
        operation: (client: S3Client) =>
          client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
            }),
            abortSignal ? { abortSignal } : undefined,
          ),
      });

      return {
        body: response.Body as Readable | undefined,
        contentType: response.ContentType ?? null,
      };
    },
  };
}
