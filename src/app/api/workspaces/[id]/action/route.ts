import { lifecycle, retrySetup } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { action } = (await req.json()) as { action: "start" | "pause" | "stop" | "setup" };
  if (action === "setup") retrySetup(id);
  else void lifecycle(id, action);
  return json({ ok: true });
});
