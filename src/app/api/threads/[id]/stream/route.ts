import { runnerFor, threadEvents, type StreamEvent } from "@/server/threads";
import type { Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

/** Server-sent events: everything after ?after=<seq>, then live events. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const runner = runnerFor(id);
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  let ping: NodeJS.Timeout;

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      let lastSeq = after;
      for (const e of threadEvents(id, after)) {
        send(e);
        lastSeq = e.seq!;
      }
      unsubscribe = runner.subscribe((e) => {
        if (e.seq !== undefined && e.seq <= lastSeq) return;
        send(e);
      });
      ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15_000);
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  req.signal.addEventListener("abort", () => {
    unsubscribe();
    clearInterval(ping);
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
