import { countJobResults, getJob, listJobResultsAfterSequence } from "@waml/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json(
      { error: "Job not found" },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const searchParams = new URL(request.url).searchParams;
  const afterSequence = Math.max(
    0,
    Number(searchParams.get("afterSequence") ?? "0") || 0,
  );
  const pageSize = Math.max(
    1,
    Number(searchParams.get("pageSize") ?? String(job.pageSize)) || job.pageSize,
  );
  const totalResults = countJobResults(jobId);
  const rows = listJobResultsAfterSequence(jobId, afterSequence, pageSize);
  const results = rows.map(({ sequenceNo: _sequenceNo, ...result }) => result);
  const nextCursor =
    rows.length === pageSize ? rows[rows.length - 1]?.sequenceNo ?? null : null;

  return NextResponse.json(
    {
      afterSequence,
      pageSize,
      totalResults,
      nextCursor,
      results,
      job,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
