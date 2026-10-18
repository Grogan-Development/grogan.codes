import { runnerFor } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return json(await runnerFor(id).meta());
});
