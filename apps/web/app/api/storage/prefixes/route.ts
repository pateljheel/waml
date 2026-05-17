import { listPrefixesForSource } from "../../../../lib/aws";
import { NextResponse } from "next/server";
import { parseDiscoverySourceFromSearchParams } from "../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = parseDiscoverySourceFromSearchParams(searchParams);
  const bucket = searchParams.get("bucket");
  const prefix = searchParams.get("prefix") ?? "";
  const continuationToken = searchParams.get("continuationToken") ?? undefined;
  const maxKeys = Number(searchParams.get("maxKeys") ?? "25");

  if ((source.provider === "s3" && !source.awsProfile) || !bucket) {
    return NextResponse.json(
      { error: "Missing required query parameters for prefix browsing" },
      { status: 400 },
    );
  }

  try {
    const result = await listPrefixesForSource({
      source,
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
          error instanceof Error ? error.message : "Failed to load prefixes",
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
