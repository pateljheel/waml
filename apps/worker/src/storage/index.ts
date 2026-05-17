import { createGcsObjectStoreReader } from "./gcs";
import { createS3ObjectStoreReader } from "./s3";
import type { WorkerObjectStoreFactoryInput, WorkerObjectStoreReader } from "./types";

export async function createObjectStoreReader(
  source: WorkerObjectStoreFactoryInput,
): Promise<WorkerObjectStoreReader> {
  switch (source.provider) {
    case "s3":
      return createS3ObjectStoreReader(source.awsProfile);
    case "gcs":
      return createGcsObjectStoreReader({
        gcpProject: source.gcpProject,
        authMode: source.authMode,
        serviceAccountKeyPath: source.serviceAccountKeyPath,
      });
    default:
      throw new Error(
        `Unsupported storage provider: ${(source as { provider: string }).provider}`,
      );
  }
}

export type {
  WorkerListedObject,
  WorkerListObjectsPage,
  WorkerObjectReadResult,
  WorkerObjectStoreReader,
} from "./types";
