import { addRepo, listRepos, removeRepo, unsavedWork } from "@/server/workspaces";
import { handle, json, type Ctx } from "@/server/http";

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { repo } = (await req.json()) as { repo: string };
  return json({ id: addRepo(id, repo) });
});

export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const repoId = sp.get("repoId")!;
  if (sp.get("force") !== "1") {
    const repo = listRepos(id).find((r) => r.id === repoId);
    const risks = repo ? await unsavedWork(id, repo.name) : [];
    if (risks.length) return json({ error: "unsaved", risks }, 409);
  }
  await removeRepo(id, repoId);
  return json({ ok: true });
});
