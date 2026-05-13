import { listAwsProfiles } from "../../../../lib/aws";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const profiles = await listAwsProfiles();
    return NextResponse.json({ profiles });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load AWS profiles",
      },
      { status: 500 },
    );
  }
}
