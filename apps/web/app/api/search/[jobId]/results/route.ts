import { countJobResults, getJob, listJobResultsPage } from "@waml/db";
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
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.max(
    1,
    Number(searchParams.get("pageSize") ?? String(job.pageSize)) || job.pageSize,
  );
  const totalResults = countJobResults(jobId);
  const results = listJobResultsPage(jobId, page, pageSize);

  return NextResponse.json(
    {
      page,
      pageSize,
      totalResults,
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
