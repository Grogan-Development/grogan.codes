import { previewUrl } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const port = Number(new URL(req.url).searchParams.get("port"));
  if (!port) return json({ error: "port required" }, 400);
  return json({ url: await previewUrl(id, port) });
});
