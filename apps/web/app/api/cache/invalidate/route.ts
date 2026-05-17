import fs from "node:fs/promises";
import { deleteCacheChunksBySourcePrefix } from "@waml/db";
import type { StorageProvider } from "@waml/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const json = await request.json();
  const input = {
    provider:
      json?.provider === "s3" ? ("s3" as StorageProvider) : ("s3" as StorageProvider),
    bucket: typeof json?.bucket === "string" ? json.bucket.trim() : "",
    rootPrefix:
      typeof json?.rootPrefix === "string" ? json.rootPrefix.trim() : "",
  };

  if (!input.bucket) {
    return NextResponse.json(
      { error: "Bucket is required" },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  const removedChunks = deleteCacheChunksBySourcePrefix(
    input.provider,
    input.bucket,
    input.rootPrefix,
  );

  await Promise.allSettled(
    removedChunks.flatMap((chunk) => [
      fs.rm(chunk.artifactPath, { force: true }),
      chunk.textCachePath
        ? fs.rm(chunk.textCachePath, { force: true })
        : Promise.resolve(),
    ]),
  );

  return NextResponse.json(
    {
      removedChunks: removedChunks.length,
      removedBytes: removedChunks.reduce(
        (total, chunk) => total + chunk.cacheSizeBytes,
        0,
      ),
      scope: {
        provider: input.provider,
        bucket: input.bucket,
        rootPrefix: input.rootPrefix,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
