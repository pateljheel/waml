import { requestMoreResults } from "@waml/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const json = await request.json().catch(() => ({}));
  const additionalResults =
    typeof json?.additionalResults === "number" && Number.isFinite(json.additionalResults)
      ? Math.max(1, Math.trunc(json.additionalResults))
      : 100;
  const job = requestMoreResults(jobId, additionalResults);

  if (!job) {
    return NextResponse.json(
      { error: "Job not found" },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  return NextResponse.json(
    { job },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
