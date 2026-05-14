import { listPrefixesForBucket } from "../../../../lib/aws";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  const bucket = searchParams.get("bucket");
  const prefix = searchParams.get("prefix") ?? "";
  const continuationToken = searchParams.get("continuationToken") ?? undefined;
  const maxKeys = Number(searchParams.get("maxKeys") ?? "25");

  if (!profile || !bucket) {
    return NextResponse.json(
      { error: "Missing required query parameters: profile and bucket" },
      { status: 400 },
    );
  }

  try {
    const result = await listPrefixesForBucket({
      profile,
      bucket,
      prefix,
      continuationToken,
      maxKeys: Number.isFinite(maxKeys) ? maxKeys : 25,
    });
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load S3 prefixes",
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }
}
