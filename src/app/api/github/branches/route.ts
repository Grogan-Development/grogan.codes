import { handle, json } from "@/server/http";
import { gh, NoToken } from "../github";

export const dynamic = "force-dynamic";

/** GET ?repo=owner/name : up to 100 branch names, default branch first. */
export const GET = handle(async (req: Request) => {
  const repo = new URL(req.url).searchParams.get("repo") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
  try {
    const [info, branches] = await Promise.all([
      gh<{ default_branch: string }>(`/repos/${repo}`),
      gh<{ name: string }[]>(`/repos/${repo}/branches?per_page=100`),
    ]);
    const names = branches.map((b) => b.name).filter((n) => n !== info.default_branch);
    return json([info.default_branch, ...names]);
  } catch (err) {
    if (err instanceof NoToken) return json({ error: err.message }, 401);
    throw err;
  }
});
