import { terminalUrl } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json({ url: await terminalUrl(id) });
});
