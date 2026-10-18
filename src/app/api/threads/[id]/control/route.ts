import { runnerFor } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json()) as { op: "interrupt" | "stopTask" | "close"; taskId?: string };
  const r = runnerFor(id);
  if (body.op === "interrupt") await r.interrupt();
  else if (body.op === "stopTask" && body.taskId) await r.stopTask(body.taskId);
  else if (body.op === "close") r.close();
  return json({ ok: true });
});
