export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body);
  return body as T;
}

export type Workspace = {
  id: string;
  name: string;
  sandbox_id: string | null;
  state: string;
  error: string | null;
  snapshot: string;
  gpu: string | null;
  cpu: number | null;
  memory_mib: number | null;
  disk_gb: number | null;
  disk_used_mb: number | null;
  idle_minutes: number;
  loadout: string;
  created_at: number;
  last_activity_at: number;
  repos: Repo[];
  activity?: {
    waiting: number;
    working: number;
    latest: { id: string; title: string; status: string; updated_at: number } | null;
    threads: ThreadSummary[];
  };
};

export type ThreadSummary = { id: string; title: string; status: string; repo: string | null; updated_at: number };

export type Repo = { id: string; name: string; url: string; branch: string | null; state: string; error: string | null };

export type Thread = {
  id: string;
  workspace_id: string;
  title: string;
  repo: string | null;
  session_id: string | null;
  model: string | null;
  permission_mode: string;
  status: string;
  updated_at: number;
};

export type CatalogItem = { id: string; kind: string; name: string; description: string | null; remote_ok: number };
export type Preset = { id: string; name: string; items: string[] };

export type RepoRisk = { repo: string; dirty: string[]; unpushed: string[]; stashes: number };

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "4 CPU · 8 GB · 50 GB", from the dials; rows created before the dials show their size preset. */
export function machineLabel(w: Pick<Workspace, "snapshot" | "cpu" | "memory_mib" | "disk_gb">) {
  if (w.cpu == null || w.memory_mib == null) return w.snapshot.replace(/^daytona-(vm-)?/, "");
  return `${w.cpu} CPU · ${w.memory_mib / 1024} GB${w.disk_gb ? ` · ${w.disk_gb} GB` : ""}`;
}

/** Fraction of the disk quota in use, or null when unknown. */
export function diskUse(w: Pick<Workspace, "disk_gb" | "disk_used_mb">) {
  return w.disk_gb && w.disk_used_mb != null ? w.disk_used_mb / 1024 / w.disk_gb : null;
}

export const CPU_STEPS = [1, 2, 4, 6, 8, 12, 16, 24, 32];
export const MEMORY_GB_STEPS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
export const DISK_GB_STEPS = [10, 20, 50, 100, 200, 500];
