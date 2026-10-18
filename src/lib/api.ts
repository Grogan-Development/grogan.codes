import { machineLabel as formatMachine, type Machine, type Market } from "@/server/aws/machines";

export type { Machine, Market };

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
  state: string;
  error: string | null;
  instance_id: string | null;
  instance_type: string | null;
  market: Market | null;
  region: string | null;
  az: string | null;
  /** 1 when the instance was launched with hibernation (every CPU type), so Pause keeps memory. */
  hibernate: number | null;
  instance_started_at?: number | null;
  disk_gb: number | null;
  disk_used_mb: number | null;
  idle_minutes: number;
  loadout: string;
  created_at: number;
  last_activity_at: number;
  /** null for rows created on Modal, which have no instance type. */
  machine: Machine | null;
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

/** "m8g.xlarge · 4 vCPU · 16 GiB"; Modal-era rows fall back to whatever type they have. */
export function machineLabel(w: Pick<Workspace, "machine" | "instance_type">) {
  return w.machine ? formatMachine(w.machine) : (w.instance_type ?? "unknown instance");
}

const FRACTIONS: Record<number, string> = { 0.125: "⅛", 0.25: "¼", 0.5: "½" };

/** "⅛ L4" for a partitioned GPU, "L4" for a whole one. */
export function gpuShare(gpu: NonNullable<Machine["gpu"]>) {
  if (!gpu.fraction) return gpu.name;
  return `${FRACTIONS[gpu.fraction] ?? `${gpu.fraction * 8}/8`} ${gpu.name}`;
}

/** Fraction of the disk in use, or null when unknown. */
export function diskUse(w: Pick<Workspace, "disk_gb" | "disk_used_mb">) {
  return w.disk_gb && w.disk_used_mb != null ? w.disk_used_mb / 1024 / w.disk_gb : null;
}

/** "$0.18" or "$0.0336" for prices under ten cents, so cheap types don't all read "$0.03". */
export function dollars(n: number) {
  return `$${n < 0.1 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
}

/** One region's infra: `missing` lists the stack's SSM parameters (including AMIs) that aren't there yet. */
export type RegionStatus = { region: string; ok: boolean; missing: string[]; error?: string };

/** GET /api/machines. `spot` and `offered` are best-effort and may be empty. */
export type MachinesInfo = {
  machines: Machine[];
  defaultType: string;
  diskSteps: number[];
  defaultDiskGb: number;
  regions: RegionStatus[];
  /** Regions where each type is offered in at least one AZ. */
  offered: Record<string, string[]>;
  /** Current lowest spot price, by region then type. */
  spot: Record<string, Record<string, number>>;
};
