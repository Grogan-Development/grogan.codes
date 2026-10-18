import { ensureStarted, unsavedWork } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await ensureStarted(id);
  return json(await unsavedWork(id, new URL(req.url).searchParams.get("repo") ?? undefined));
});
