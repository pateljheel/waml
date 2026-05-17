import type { BrowserStorage, BrowserStorageFactoryInput } from "./types";
import { createS3BrowserStorage } from "./s3";

export async function createBrowserStorage(
  input: BrowserStorageFactoryInput,
): Promise<BrowserStorage> {
  switch (input.provider) {
    case "s3":
      return createS3BrowserStorage(input.awsProfile);
    default:
      throw new Error(`Unsupported storage provider: ${(input as { provider: string }).provider}`);
  }
}

export type { BrowserStorage, BrowserStorageListResult } from "./types";
