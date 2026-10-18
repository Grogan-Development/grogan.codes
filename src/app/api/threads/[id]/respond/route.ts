import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { existingRunner } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { requestId, result } = (await req.json()) as { requestId: string; result: PermissionResult };
  const ok = existingRunner(id)?.respond(requestId, result) ?? false;
  return json({ ok }, ok ? 200 : 404);
});
