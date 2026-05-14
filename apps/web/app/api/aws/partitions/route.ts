import { inferPartitions } from "../../../../lib/aws";
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

  if (!profile || !bucket) {
    return NextResponse.json(
      { error: "Missing required query parameters: profile and bucket" },
      { status: 400 },
    );
  }

  try {
    const result = await inferPartitions({
      profile,
      bucket,
      rootPrefix,
      pathPattern,
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
            : "Failed to infer Hive partitions",
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
