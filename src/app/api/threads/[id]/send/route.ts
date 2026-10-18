import { runnerFor } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json()) as {
    text: string;
    images?: { mediaType: string; data: string }[];
    priority?: "now" | "next" | "later";
  };
  // Don't await the turn; it streams over /stream. Startup errors surface as status events.
  void runnerFor(id).send(body.text, { images: body.images, priority: body.priority }).catch(() => {});
  return json({ ok: true });
});
