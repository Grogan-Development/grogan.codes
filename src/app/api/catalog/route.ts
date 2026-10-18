import { addMcpServer, importLocal, listCatalog, removeCatalogItem } from "@/server/catalog";
import { handle, json } from "@/server/http";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  if (listCatalog().length === 0) importLocal();
  return json(listCatalog().map(({ data: _data, ...rest }) => rest));
});

export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as { op: "import" | "addMcp" | "remove"; name?: string; config?: McpServerConfig; id?: string };
  if (body.op === "import") importLocal();
  if (body.op === "addMcp" && body.name && body.config) addMcpServer(body.name, body.config);
  if (body.op === "remove" && body.id) removeCatalogItem(body.id);
  return json({ ok: true });
});
