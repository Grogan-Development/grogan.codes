import { createThread, listThreads } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json(listThreads(id));
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { repo?: string | null; forkOf?: string };
  return json(createThread(id, body));
});
