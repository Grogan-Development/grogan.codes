import { deleteThread, existingRunner, getThread, renameThread, runnerFor, threadEvents } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const runner = existingRunner(id);
  return json({
    thread: getThread(id),
    events: threadEvents(id),
    pending: runner?.pendingRequests() ?? [],
    alive: runner?.alive ?? false,
  });
});

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json()) as { title?: string; model?: string | null; permissionMode?: PermissionMode };
  if (body.title) renameThread(id, body.title);
  if (body.model !== undefined) await runnerFor(id).setModel(body.model);
  if (body.permissionMode) await runnerFor(id).setPermissionMode(body.permissionMode);
  return json(getThread(id));
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  deleteThread(id);
  return json({ ok: true });
});
