import type { NotebookSource } from "@waml/shared";

export type BrowserStorageListResult = {
  objectKeys: string[];
  commonPrefixes: string[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
};

export type BrowserStorage = {
  listBuckets(): Promise<string[]>;
  listObjects(args: {
    bucket: string;
    prefix: string;
    delimiter?: string;
    continuationToken?: string;
    maxKeys: number;
  }): Promise<BrowserStorageListResult>;
};

export type BrowserStorageFactoryInput = Pick<
  NotebookSource,
  "provider" | "awsProfile" | "gcpProject" | "authMode" | "serviceAccountKeyPath"
>;
