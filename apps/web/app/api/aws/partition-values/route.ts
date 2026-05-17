import { searchPartitionValues } from "../../../../lib/aws";
import { normalizePrefixFilters } from "@waml/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  const bucket = searchParams.get("bucket");
  const rootPrefix = searchParams.get("rootPrefix") ?? "";
  const pathPattern = searchParams.get("pathPattern") ?? "";
  const key = searchParams.get("key");
  const search = searchParams.get("search") ?? "";
  const selectedFiltersParam = searchParams.get("selectedFilters") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "25");

  if (!profile || !bucket || !key) {
    return NextResponse.json(
      { error: "Missing required query parameters: profile, bucket, and key" },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  try {
    const selectedFilters = selectedFiltersParam
      ? normalizePrefixFilters(JSON.parse(selectedFiltersParam))
      : {};
    const result = await searchPartitionValues({
      source: {
        provider: "s3",
        awsProfile: profile,
        gcpProject: "",
        authMode: "adc",
        serviceAccountKeyPath: "",
      },
      bucket,
      rootPrefix,
      pathPattern,
      key,
      search,
      selectedFilters,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
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
          error instanceof Error
            ? error.message
            : "Failed to load partition values",
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
