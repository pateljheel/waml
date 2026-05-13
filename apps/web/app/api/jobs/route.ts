import { createJob, listJobs } from "@waml/db";
import { createSearchJobInputSchema } from "@waml/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(request: Request) {
  const json = await request.json();
  const input = createSearchJobInputSchema.parse(json);
  const job = createJob(input);

  return NextResponse.json({ job }, { status: 201 });
}
