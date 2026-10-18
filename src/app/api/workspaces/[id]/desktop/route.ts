import { startDesktop, stopDesktop } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json({ wsUrl: await startDesktop(id) });
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await stopDesktop(id);
  return json({ ok: true });
});
