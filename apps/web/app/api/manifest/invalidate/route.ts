import { deleteManifestBySourcePrefix } from "@waml/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as
    | { bucket?: string; rootPrefix?: string }
    | null;
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

  const result = deleteManifestBySourcePrefix(bucket, rootPrefix);

  return NextResponse.json(
    {
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
