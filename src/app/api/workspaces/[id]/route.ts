import { db } from "@/server/db";
import { deleteWorkspace, getWorkspace, listRepos, setIdleMinutes, syncState, unsavedWork, workspaceJson } from "@/server/workspaces";
import { listThreads } from "@/server/threads";
import { handle, json, type Ctx } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const w = await syncState(id);
  return json({ ...workspaceJson(w), repos: listRepos(id), threads: listThreads(id) });
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
  // Without an instance (Modal-era rows, setup that never launched) there is nothing to lose.
  const w = getWorkspace(id);
  const forced = new URL(req.url).searchParams.get("force") === "1";
  if (!forced && w.archived_at) return json({ error: "The workspace is in cold storage. Force delete to remove it and its snapshot." }, 409);
  const force = forced || !w.instance_id;
  if (!force) {
    const risks = await unsavedWork(id).catch(() => null);
    if (risks === null) {
      const error =
        w.state === "stopped"
          ? "The workspace is stopped. Start it to check for unpushed work, or force delete."
          : "Could not check for unsaved work (is the workspace running?). Start it first, or force delete.";
      return json({ error }, 409);
    }
    if (risks.length) return json({ error: "unsaved", risks }, 409);
  }
  await deleteWorkspace(id);
  return json({ ok: true });
});
