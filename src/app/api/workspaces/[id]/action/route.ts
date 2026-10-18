import { archiveWorkspace, isBusy, lifecycle, retrySetup } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { action } = (await req.json()) as { action: "start" | "pause" | "stop" | "setup" | "archive" };
  if (isBusy(id)) return json({ error: "Workspace is busy with another start, stop or setup. Try again in a moment." }, 409);
  if (action === "setup") retrySetup(id);
  else if (action === "archive") archiveWorkspace(id); // validates, then runs in the background
  else void lifecycle(id, action).catch(() => {}); // failures land on the row; a race lost to another action is a no-op
  return json({ ok: true });
});
