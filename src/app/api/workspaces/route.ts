import { createWorkspace, listRepos, listWorkspaces, workspaceJson } from "@/server/workspaces";
import { DEFAULT_DISK_GB, DEFAULT_MACHINE, type Market } from "@/server/aws/machines";
import { listThreads } from "@/server/threads";
import { handle, json } from "@/server/http";
import { defaultLoadout } from "@/server/catalog";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  return json(
    listWorkspaces().map((w) => {
      const threads = listThreads(w.id);
      const recent = [...threads].sort((a, b) => b.updated_at - a.updated_at);
      const latest = recent[0];
      return {
        ...workspaceJson(w),
        repos: listRepos(w.id),
        activity: {
          waiting: threads.filter((t) => t.status === "waiting").length,
          working: threads.filter((t) => t.status === "running" || t.status === "starting").length,
          latest: latest ? { id: latest.id, title: latest.title, status: latest.status, updated_at: latest.updated_at } : null,
          // One square per thread on the home screen, oldest first so new ones appear at the end.
          threads: recent
            .slice(0, 40)
            .reverse()
            .map((t) => ({ id: t.id, title: t.title, status: t.status, repo: t.repo, updated_at: t.updated_at })),
        },
      };
    }),
  );
});

export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as {
    name: string;
    instanceType?: string;
    market?: Market;
    region?: string;
    diskGb?: number;
    idleMinutes?: number;
    repos?: string[];
    loadout?: string[];
  };
  const name = body.name?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!name) return json({ error: "Name is required" }, 400);
  return json(
    workspaceJson(
      await createWorkspace({
        name,
        instanceType: body.instanceType ?? DEFAULT_MACHINE,
        market: body.market ?? "on-demand",
        region: body.region || "auto",
        diskGb: body.diskGb ?? DEFAULT_DISK_GB,
        idleMinutes: body.idleMinutes ?? 30,
        repos: body.repos ?? [],
        loadout: body.loadout ?? defaultLoadout(),
      }),
    ),
  );
});
