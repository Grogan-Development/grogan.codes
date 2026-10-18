import { githubToken } from "@/server/secrets";

/** What the repo combobox shows. */
export type GhRepo = {
  fullName: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  language: string | null;
};

type RawRepo = {
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string | null;
  language: string | null;
};

export class NoToken extends Error {
  constructor() {
    super("Sign in with gh auth login");
  }
}

/** GET a GitHub REST path with the gh CLI's token. Throws NoToken when gh isn't signed in. */
export async function gh<T>(path: string): Promise<T> {
  const token = githubToken();
  if (!token) throw new NoToken();
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (res.status === 401) throw new NoToken();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const toRepo = (r: RawRepo): GhRepo => ({
  fullName: r.full_name,
  private: r.private,
  fork: r.fork,
  archived: r.archived,
  description: r.description,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at,
  language: r.language,
});

const g = globalThis as unknown as { __csGhRepos?: { at: number; token: string; repos: GhRepo[]; login: string; orgs: string[] } };

/** The user's 100 most recently pushed repos (own, collaborator, org member), plus login and orgs. Cached 60s. */
export async function myRepos() {
  const token = githubToken() ?? "";
  const hit = g.__csGhRepos;
  if (hit && hit.token === token && Date.now() - hit.at < 60_000) return hit;
  const [raw, user, orgs] = await Promise.all([
    gh<RawRepo[]>("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100"),
    gh<{ login: string }>("/user"),
    gh<{ login: string }[]>("/user/orgs?per_page=100").catch(() => []),
  ]);
  g.__csGhRepos = { at: Date.now(), token, repos: raw.map(toRepo), login: user.login, orgs: orgs.map((o) => o.login) };
  return g.__csGhRepos;
}

/** Repos by name beyond the cached 100, scoped to the user and their orgs. */
export async function searchRepos(q: string, login: string, orgs: string[]): Promise<GhRepo[]> {
  const scopes = [`user:${login}`, ...orgs.map((o) => `org:${o}`)].join(" ");
  const query = encodeURIComponent(`${q} in:name ${scopes}`);
  const res = await gh<{ items: RawRepo[] }>(`/search/repositories?q=${query}&sort=updated&per_page=30`);
  return res.items.map(toRepo);
}
