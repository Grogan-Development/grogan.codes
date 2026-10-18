import { db } from "@/server/db";
import { deleteWorkspace, listRepos, setIdleMinutes, syncState, unsavedWork } from "@/server/workspaces";
import { listThreads } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const w = await syncState(id);
  return json({ ...w, repos: listRepos(id), threads: listThreads(id) });
});

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json()) as { idleMinutes?: number; loadout?: string[] };
  if (body.idleMinutes) await setIdleMinutes(id, body.idleMinutes);
  if (body.loadout) db().prepare("UPDATE workspaces SET loadout = ? WHERE id = ?").run(JSON.stringify(body.loadout), id);
  return json({ ok: true });
});

export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force) {
    const risks = await unsavedWork(id).catch(() => null);
    if (risks === null) return json({ error: "Could not check for unsaved work (is the workspace running?). Start it first, or force delete." }, 409);
    if (risks.length) return json({ error: "unsaved", risks }, 409);
  }
  await deleteWorkspace(id);
  return json({ ok: true });
});
