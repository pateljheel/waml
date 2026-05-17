import { inferPartitions } from "../../../../lib/aws";
import { normalizePrefixFilters } from "@waml/shared";
import { NextResponse } from "next/server";
import { parseDiscoverySourceFromSearchParams } from "../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = parseDiscoverySourceFromSearchParams(searchParams);
  const bucket = searchParams.get("bucket");
  const rootPrefix = searchParams.get("rootPrefix") ?? "";
  const pathPattern = searchParams.get("pathPattern") ?? "";
  const selectedFiltersParam = searchParams.get("selectedFilters") ?? "";

  if ((source.provider === "s3" && !source.awsProfile) || !bucket) {
    return NextResponse.json(
      { error: "Missing required query parameters for partition inference" },
      { status: 400 },
    );
  }

  try {
    const selectedFilters = selectedFiltersParam
      ? normalizePrefixFilters(JSON.parse(selectedFiltersParam))
      : {};
    const result = await inferPartitions({
      source,
      bucket,
      rootPrefix,
      pathPattern,
      selectedFilters,
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
          error instanceof Error ? error.message : "Failed to infer partitions",
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
