import { handle, json } from "@/server/http";
import { myRepos, NoToken, searchRepos, type GhRepo } from "../github";

export const dynamic = "force-dynamic";

/**
 * GET ?q= : the user's recently pushed repos, filtered by q. With q, GitHub search (scoped to the
 * user and their orgs) adds repos beyond the cached 100; if search fails the filtered list stands.
 */
export const GET = handle(async (req: Request) => {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  try {
    const mine = await myRepos();
    if (!q) return json(mine.repos);
    const local = mine.repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
    // Search syntax would choke on spaces and qualifiers; only plain names go to it.
    let found: GhRepo[] = [];
    if (/^[\w.-]+$/.test(q)) found = await searchRepos(q, mine.login, mine.orgs).catch(() => []);
    const seen = new Set(local.map((r) => r.fullName));
    return json([...local, ...found.filter((r) => !seen.has(r.fullName))].slice(0, 50));
  } catch (err) {
    if (err instanceof NoToken) return json({ error: err.message }, 401);
    throw err;
  }
});
