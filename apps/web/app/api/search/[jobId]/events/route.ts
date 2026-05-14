import { getJob, listJobEvents } from "@waml/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const encoder = new TextEncoder();

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function serializeEvent(event: {
  sequenceNo: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}) {
  return encoder.encode(
    `id: ${event.sequenceNo}\n` +
      `data: ${JSON.stringify({
        type: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
      })}\n\n`,
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getJob(jobId);

  if (!job) {
    return new Response("Job not found", { status: 404 });
  }

  const lastEventIdHeader = request.headers.get("last-event-id");
  const searchParams = new URL(request.url).searchParams;
  const initialSequenceNo = Number(
    searchParams.get("since") ?? lastEventIdHeader ?? "0",
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let sequenceNo = Number.isFinite(initialSequenceNo) ? initialSequenceNo : 0;

      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      request.signal.addEventListener("abort", close);

      try {
        while (!closed) {
          const events = listJobEvents(jobId, sequenceNo, 200);

          for (const event of events) {
            controller.enqueue(serializeEvent(event));
            sequenceNo = event.sequenceNo;
          }

          const nextJob = getJob(jobId);

          if (
            nextJob?.status === "completed" ||
            nextJob?.status === "failed" ||
            nextJob?.status === "cancelled"
          ) {
            close();
            return;
          }

          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          await sleep(400);
        }
      } catch {
        close();
      }
    },
    cancel() {
      // No-op.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
