import type { SearchJob } from "@waml/shared";
import type { Readable } from "node:stream";

export type WorkerListedObject = {
  key: string;
  etag: string;
  size: number;
  lastModified: string;
};

export type WorkerListObjectsPage = {
  objects: WorkerListedObject[];
  nextContinuationToken: string | null;
};

export type WorkerObjectReadResult = {
  body: Readable | undefined;
  contentType?: string | null;
};

export type WorkerObjectStoreReader = {
  listObjectsPage(args: {
    bucket: string;
    prefix: string;
    continuationToken?: string;
    maxKeys: number;
  }): Promise<WorkerListObjectsPage>;
  getObject(args: {
    bucket: string;
    key: string;
    abortSignal?: AbortSignal;
  }): Promise<WorkerObjectReadResult>;
};

export type WorkerObjectStoreFactoryInput = SearchJob["source"];
