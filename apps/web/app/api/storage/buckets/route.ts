import { searchBucketsForSource } from "../../../../lib/aws";
import { NextResponse } from "next/server";
import { parseDiscoverySourceFromSearchParams } from "../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = parseDiscoverySourceFromSearchParams(searchParams);
  const search = searchParams.get("search") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "10");

  if (source.provider === "s3" && !source.awsProfile) {
    return NextResponse.json(
      { error: "Missing required query parameter: awsProfile" },
      { status: 400 },
    );
  }

  try {
    const result = await searchBucketsForSource({
      source,
      search,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 10,
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
          error instanceof Error ? error.message : "Failed to load buckets",
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
