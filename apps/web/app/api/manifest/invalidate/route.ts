import { deleteManifestBySourcePrefix } from "@waml/db";
import type { StorageProvider } from "@waml/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as
    | { provider?: StorageProvider; bucket?: string; rootPrefix?: string }
    | null;
  const provider = payload?.provider === "gcs" ? "gcs" : "s3";
  const bucket = payload?.bucket?.trim() ?? "";
  const rootPrefix = payload?.rootPrefix?.trim() ?? "";

  if (!bucket) {
    return NextResponse.json(
      { error: "bucket is required" },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  const result = deleteManifestBySourcePrefix(provider, bucket, rootPrefix);

  return NextResponse.json(
    {
      provider,
      removedScopes: result.removedScopes,
      removedObjects: result.removedObjects,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
