import { timePreviewInputSchema } from "@waml/shared";
import { NextResponse } from "next/server";
import { previewTimeConfig } from "../../../../lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const input = timePreviewInputSchema.parse(json);
    const result = previewTimeConfig(input);

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to preview time configuration",
      },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }
}
