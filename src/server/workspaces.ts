import { nanoid } from "nanoid";
import type { Sandbox } from "modal";
import { db, now } from "./db";
import {
  modal,
  modalApp,
  sandbox,
  forgetSandbox,
  run,
  mustRun,
  q,
  BASE_IMAGE,
  MAX_LIFETIME_MS,
  WORKSPACE_ROOT,
  HOME,
  TERMINAL_PORT,
  VNC_PORT,
} from "./modal";
import { githubToken, gitIdentity } from "./secrets";

/** CPU cores and memory per size. A GPU, when chosen, is added on top. */
export const SIZES = {
  small: { cpu: 1, memoryMiB: 1024 },
  medium: { cpu: 2, memoryMiB: 4096 },
  large: { cpu: 4, memoryMiB: 8192 },
} as const;
export type Size = keyof typeof SIZES;

/** Dial stops offered in the UI; the server accepts only these. */
export const CPU_STEPS = [1, 2, 4, 6, 8, 12, 16, 24, 32];
export const MEMORY_GB_STEPS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
export const DISK_GB_STEPS = [10, 20, 50, 100, 200, 500];

/** Modal GPU types offered in the UI. */
export const GPUS = ["T4", "L4", "A10G", "L40S", "A100", "A100-80GB", "H100", "H200", "B200"] as const;

export type Workspace = {
  id: string;
  name: string;
  sandbox_id: string | null;
  state: string;
  error: string | null;
  /** The size name (small/medium/large). Rows from the Daytona era hold "daytona-vm-<size>". */
  snapshot: string;
  /** Modal GPU spec such as "H100" or "H100:2", or null for CPU only. */
  gpu: string | null;
  /** Filesystem snapshot the next start boots from; null until the first stop. */
  image_id: string | null;
  sandbox_started_at: number | null;
  cpu: number | null;
  memory_mib: number | null;
  /** Modal can't size a sandbox's disk, so this is a soft quota the app watches (disk_used_mb). */
  disk_gb: number | null;
  disk_used_mb: number | null;
  idle_minutes: number;
  loadout: string;
  loadout_applied_hash: string | null;
  created_at: number;
  last_activity_at: number;
};

export type Repo = {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  branch: string | null;
  state: string;
  error: string | null;
};

export function listWorkspaces(): Workspace[] {
  return db().prepare("SELECT * FROM workspaces ORDER BY last_activity_at DESC").all() as Workspace[];
}

export function getWorkspace(id: string): Workspace {
  const w = db().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Workspace | undefined;
  if (!w) throw new Error(`Workspace ${id} not found`);
  return w;
}

export function listRepos(workspaceId: string): Repo[] {
  return db().prepare("SELECT * FROM repos WHERE workspace_id = ? ORDER BY name").all(workspaceId) as Repo[];
}

function setState(id: string, state: string, error: string | null = null) {
  db().prepare("UPDATE workspaces SET state = ?, error = ? WHERE id = ?").run(state, error, id);
}

function sizeOf(w: Workspace): Size {
  const s = w.snapshot.replace(/^daytona-(vm-)?/, "");
  return s in SIZES ? (s as Size) : "large";
}

export async function workspaceSandbox(id: string): Promise<Sandbox> {
  const w = getWorkspace(id);
  if (!w.sandbox_id) throw new Error("Workspace isn't running");
  return sandbox(w.sandbox_id);
}

/** Normalize "owner/repo", https or ssh GitHub URLs into a clone URL and a folder name. */
export function parseRepo(input: string): { url: string; name: string } {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  const url = short ? `https://github.com/${short[1]}/${short[2]}.git` : ssh ? `https://${ssh[1]}/${ssh[2]}.git` : `${s}.git`;
  const name = url.split("/").pop()!.replace(/\.git$/, "");
  assertRepoName(name, input);
  return { url, name };
}

/** The name becomes a folder under ~/workspace that removal deletes, so it must be one plain path segment. */
function assertRepoName(name: string, input = name) {
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) throw new Error(`Can't use "${input}" as a repo: "${name}" isn't a valid folder name`);
}

/** "H100" or "H100:2"; anything else is rejected before a sandbox is created. */
export function parseGpu(input: string | null | undefined): string | null {
  if (!input) return null;
  const [type, count = "1"] = input.split(":");
  const n = Number(count);
  if (!(GPUS as readonly string[]).includes(type) || !Number.isInteger(n) || n < 1 || n > 8) throw new Error(`Unknown GPU "${input}"`);
  return n === 1 ? type : `${type}:${n}`;
}

export type Machine = { cpu: number; memoryGb: number; diskGb: number };

function assertStep(value: number, steps: number[], what: string) {
  if (!steps.includes(value)) throw new Error(`${what} must be one of ${steps.join(", ")}`);
}

export function createWorkspace(input: {
  name: string;
  size: Size;
  machine?: Machine;
  gpu?: string | null;
  idleMinutes: number;
  repos: string[];
  loadout: string[];
}) {
  const repos = input.repos.filter(Boolean).map(parseRepo); // validate before creating anything
  const gpu = parseGpu(input.gpu);
  const m = input.machine ?? { cpu: SIZES[input.size].cpu, memoryGb: SIZES[input.size].memoryMiB / 1024, diskGb: 50 };
  assertStep(m.cpu, CPU_STEPS, "CPU");
  assertStep(m.memoryGb, MEMORY_GB_STEPS, "Memory");
  assertStep(m.diskGb, DISK_GB_STEPS, "Disk");
  const id = nanoid(10);
  const t = now();
  db()
    .prepare(
      `INSERT INTO workspaces (id, name, state, snapshot, gpu, cpu, memory_mib, disk_gb, idle_minutes, loadout, created_at, last_activity_at)
       VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.size, gpu, m.cpu, m.memoryGb * 1024, m.diskGb, input.idleMinutes, JSON.stringify(input.loadout), t, t);
  for (const { url, name } of repos) {
    db().prepare("INSERT INTO repos (id, workspace_id, name, url, state) VALUES (?, ?, ?, ?, 'pending')").run(nanoid(10), id, name, url);
  }
  void provision(id);
  return getWorkspace(id);
}

/** Bootstrap failures get their own state so syncState can't paper over them. */
export const SETUP_FAILED = "setup failed";

/** Boot a sandbox for the workspace, from its last snapshot if it has one. */
async function bootSandbox(w: Workspace): Promise<Sandbox> {
  const m = modal();
  const image = w.image_id ? await m.images.fromId(w.image_id) : m.images.fromRegistry(BASE_IMAGE);
  const preset = SIZES[sizeOf(w)];
  const cpu = w.cpu ?? preset.cpu;
  const memoryMiB = w.memory_mib ?? preset.memoryMiB;
  // Modal treats cpu/memoryMiB as reservations; the limits make the dials hard caps.
  const sb = await m.sandboxes.create(await modalApp(), image, {
    cpu,
    cpuLimit: cpu,
    memoryMiB,
    memoryLimitMiB: memoryMiB,
    gpu: w.gpu ?? undefined,
    timeoutMs: MAX_LIFETIME_MS,
    workdir: WORKSPACE_ROOT,
    tags: { app: "codespace", workspace: w.id },
  });
  db().prepare("UPDATE workspaces SET sandbox_id = ?, sandbox_started_at = ? WHERE id = ?").run(sb.sandboxId, now(), w.id);
  return sb;
}

async function provision(id: string) {
  const w = getWorkspace(id);
  try {
    let sb: Sandbox;
    const alive = w.sandbox_id ? await isAlive(w.sandbox_id) : false;
    if (alive) {
      // Retrying a failed setup: reuse the sandbox that was already created.
      setState(id, "setting up");
      sb = await sandbox(w.sandbox_id!, true);
    } else {
      setState(id, "creating");
      sb = await bootSandbox(w);
      setState(id, "setting up");
    }
    await bootstrap(sb);
    setState(id, "started");
    for (const repo of listRepos(id)) if (repo.state !== "ready") await cloneRepo(id, repo.id);
  } catch (err) {
    setState(id, SETUP_FAILED, String(err instanceof Error ? err.message : err));
  }
}

export function retrySetup(id: string) {
  if (getWorkspace(id).state !== SETUP_FAILED) throw new Error("Workspace setup hasn't failed");
  void provision(id);
}

/** Idempotent machine setup: Claude Code, gh, ttyd, git identity and GitHub auth. */
export async function bootstrap(sb: Sandbox) {
  await mustRun(sb, `mkdir -p ${WORKSPACE_ROOT} ${HOME}/.claude`);
  await mustRun(sb, `command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash`, { timeout: 900 });
  await run(sb, `command -v gh >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh)`, { timeout: 900 });
  await run(
    sb,
    `command -v ttyd >/dev/null || (curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$(uname -m) && chmod +x /usr/local/bin/ttyd)`,
    { timeout: 300 },
  );
  const id = gitIdentity();
  if (id.name) await run(sb, `git config --global user.name ${q(id.name)}`);
  if (id.email) await run(sb, `git config --global user.email ${q(id.email)}`);
  const token = githubToken();
  if (token) {
    await run(sb, `printf %s "$CS_GH_TOKEN" | gh auth login --with-token && gh auth setup-git`, { env: { CS_GH_TOKEN: token } });
  }
  // Skip Claude's first-run onboarding in the terminal.
  await run(sb, `test -f ~/.claude.json || echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > ~/.claude.json`);
}

export function addRepo(workspaceId: string, input: string) {
  const { url, name } = parseRepo(input);
  const id = nanoid(10);
  db().prepare("INSERT INTO repos (id, workspace_id, name, url, state) VALUES (?, ?, ?, ?, 'pending')").run(id, workspaceId, name, url);
  void cloneRepo(workspaceId, id);
  return id;
}

async function cloneRepo(workspaceId: string, repoId: string) {
  const repo = db().prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as Repo;
  const setRepo = (state: string, error: string | null = null) =>
    db().prepare("UPDATE repos SET state = ?, error = ? WHERE id = ?").run(state, error, repoId);
  try {
    setRepo("cloning");
    const sb = await ensureStarted(workspaceId);
    const dest = `${WORKSPACE_ROOT}/${repo.name}`;
    await mustRun(sb, `test -d ${q(dest)}/.git || git clone ${q(repo.url)} ${q(dest)}`, { timeout: 1800 });
    const branch = (await run(sb, `git -C ${q(dest)} rev-parse --abbrev-ref HEAD`)).output.trim();
    db().prepare("UPDATE repos SET branch = ? WHERE id = ?").run(branch, repoId);
    setRepo("ready");
  } catch (err) {
    setRepo("error", String(err instanceof Error ? err.message : err));
  }
}

export type RepoRisk = { repo: string; dirty: string[]; unpushed: string[]; stashes: number };

/** Work that exists only in the workspace and would be lost if it is deleted. */
export async function unsavedWork(workspaceId: string, onlyRepo?: string): Promise<RepoRisk[]> {
  const sb = await workspaceSandbox(workspaceId);
  const out = (await run(sb, `cd ${WORKSPACE_ROOT} 2>/dev/null && ls -d */.git 2>/dev/null | sed 's#/.git##'`)).output;
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean).filter((n) => onlyRepo === undefined || n === onlyRepo);
  const risks: RepoRisk[] = [];
  for (const name of names) {
    const dir = q(`${WORKSPACE_ROOT}/${name}`);
    const dirty = (await run(sb, `git -C ${dir} status --porcelain`)).output.split("\n").filter(Boolean);
    const unpushed = (await run(sb, `git -C ${dir} log --branches --not --remotes --oneline`)).output.split("\n").filter(Boolean);
    const stashes = (await run(sb, `git -C ${dir} stash list`)).output.split("\n").filter(Boolean).length;
    if (dirty.length || unpushed.length || stashes) risks.push({ repo: name, dirty, unpushed, stashes });
  }
  return risks;
}

export async function removeRepo(workspaceId: string, repoId: string) {
  const repo = db().prepare("SELECT * FROM repos WHERE id = ? AND workspace_id = ?").get(repoId, workspaceId) as Repo | undefined;
  if (!repo) throw new Error(`Repo ${repoId} not found`);
  const sb = await workspaceSandbox(workspaceId);
  // Rows saved before names were validated can hold "" or "..": drop the row, never the folder.
  try {
    assertRepoName(repo.name);
  } catch {
    db().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    return;
  }
  await run(sb, `rm -rf ${q(`${WORKSPACE_ROOT}/${repo.name}`)}`);
  db().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
}

async function isAlive(sandboxId: string): Promise<boolean> {
  try {
    const sb = await sandbox(sandboxId, true);
    return (await sb.poll()) === null;
  } catch {
    return false;
  }
}

/**
 * Modal sandboxes can't pause, so "pause" and "stop" both snapshot the filesystem and
 * terminate the sandbox. The next start boots a new sandbox from that snapshot: files
 * are kept, running processes are not.
 */
async function snapshotAndStop(id: string) {
  const w = getWorkspace(id);
  if (!w.sandbox_id) return;
  setState(id, "snapshotting");
  const sb = await sandbox(w.sandbox_id, true);
  const image = await sb.snapshotFilesystem({ timeoutMs: 600_000 });
  db().prepare("UPDATE workspaces SET image_id = ? WHERE id = ?").run(image.imageId, id);
  await sb.terminate();
  forgetSandbox(w.sandbox_id);
  db().prepare("UPDATE workspaces SET sandbox_id = NULL, sandbox_started_at = NULL WHERE id = ?").run(id);
  setState(id, "stopped");
}

async function start(id: string): Promise<Sandbox> {
  setState(id, "starting");
  const sb = await bootSandbox(getWorkspace(id));
  setState(id, "started");
  return sb;
}

export async function lifecycle(id: string, action: "start" | "pause" | "stop") {
  try {
    if (action === "start") {
      const w = await syncState(id);
      if (w.state !== "started") await start(id);
    } else await snapshotAndStop(id);
  } catch (err) {
    setState(id, "error", String(err instanceof Error ? err.message : err));
  }
}

export async function deleteWorkspace(id: string) {
  const w = getWorkspace(id);
  if (w.sandbox_id) {
    try {
      const sb = await sandbox(w.sandbox_id, true);
      await sb.terminate();
    } catch (err) {
      if (!/not ?found/i.test(String(err))) throw err;
    }
    forgetSandbox(w.sandbox_id);
  }
  db().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

export async function setIdleMinutes(id: string, minutes: number) {
  db().prepare("UPDATE workspaces SET idle_minutes = ? WHERE id = ?").run(minutes, id);
}

const BUSY = ["creating", "setting up", "starting", "snapshotting", SETUP_FAILED];

/** Notice sandboxes that ended on their own (lifetime cap, crash) and recover from interrupted snapshots. */
export async function syncState(id: string) {
  const w = getWorkspace(id);
  if (BUSY.includes(w.state)) return w;
  if (!w.sandbox_id) {
    if (w.state === "started") setState(id, "stopped");
    return getWorkspace(id);
  }
  if (await isAlive(w.sandbox_id)) {
    if (w.state !== "started") setState(id, "started");
  } else {
    forgetSandbox(w.sandbox_id);
    db().prepare("UPDATE workspaces SET sandbox_id = NULL, sandbox_started_at = NULL WHERE id = ?").run(id);
    setState(id, "stopped", w.image_id ? "The sandbox ended on its own. Changes since the last snapshot were lost." : "The sandbox ended before its first snapshot.");
  }
  return getWorkspace(id);
}

/** Make sure a sandbox is running before using it (boots one from the last snapshot). */
export async function ensureStarted(id: string): Promise<Sandbox> {
  const w = await syncState(id);
  if (w.state === SETUP_FAILED) throw new Error(`Workspace setup failed: ${w.error ?? "unknown error"}. Retry setup first.`);
  if (w.state === "started" && w.sandbox_id) return sandbox(w.sandbox_id);
  if (w.state === "setting up" && w.sandbox_id) return sandbox(w.sandbox_id);
  if (BUSY.includes(w.state)) throw new Error(`Workspace is ${w.state}. Try again in a moment.`);
  return start(id);
}

// ---- Activity and the idle reaper ------------------------------------------

/** Record user or agent activity. The reaper below reads it. */
export function touch(id: string) {
  db().prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?").run(now(), id);
}

/** Snapshot before Modal's 24h cap so a long-lived workspace never loses work to it. */
const LIFETIME_MARGIN_MS = 30 * 60_000;

const DISK_CHECK_MS = 5 * 60_000;
let lastDiskCheck = 0;

/** Record how much of its disk quota each running workspace uses; the UI warns as it fills. */
async function checkDisk(running: Workspace[]) {
  if (now() - lastDiskCheck < DISK_CHECK_MS) return;
  lastDiskCheck = now();
  for (const w of running) {
    try {
      const sb = await sandbox(w.sandbox_id!);
      // df under Modal's gVisor doesn't track overlay writes, so measure the home directory itself.
      const used = Number((await run(sb, `du -sm ${HOME} 2>/dev/null | cut -f1`, { timeout: 120 })).output.trim());
      if (Number.isFinite(used)) db().prepare("UPDATE workspaces SET disk_used_mb = ? WHERE id = ?").run(used, w.id);
    } catch {}
  }
}

async function reap() {
  const running = db().prepare("SELECT * FROM workspaces WHERE state = 'started' AND sandbox_id IS NOT NULL").all() as Workspace[];
  await checkDisk(running);
  for (const w of running) {
    const busy = db().prepare("SELECT 1 FROM threads WHERE workspace_id = ? AND status IN ('starting', 'running', 'waiting')").get(w.id);
    const idle = now() - w.last_activity_at > w.idle_minutes * 60_000;
    const nearCap = w.sandbox_started_at !== null && now() - w.sandbox_started_at > MAX_LIFETIME_MS - LIFETIME_MARGIN_MS;
    if ((idle && !busy) || nearCap) await lifecycle(w.id, "stop");
  }
}

const g = globalThis as unknown as { __csReaper?: NodeJS.Timeout };
if (!g.__csReaper) {
  g.__csReaper = setInterval(() => void reap().catch((err) => console.error("[reaper]", err)), 60_000);
  g.__csReaper.unref();
}

// ---- Ports, terminal, desktop and diff --------------------------------------

/** An auth-gated URL for a port: Modal's proxy checks the connect token in the query string. */
export async function previewUrl(id: string, port: number) {
  const sb = await ensureStarted(id);
  touch(id);
  const cred = await sb.createConnectToken({ port });
  return withToken(cred.url, cred.token);
}

function withToken(base: string, token: string, pathAndQuery = "") {
  const u = new URL(pathAndQuery || "/", base);
  u.searchParams.set("_modal_connect_token", token);
  return u.toString();
}

export async function terminalUrl(id: string) {
  const sb = await ensureStarted(id);
  await run(sb, `pgrep -x ttyd >/dev/null || (cd ${WORKSPACE_ROOT} && nohup ttyd -p ${TERMINAL_PORT} -W bash >/tmp/ttyd.log 2>&1 &)`);
  await new Promise((r) => setTimeout(r, 500));
  return previewUrl(id, TERMINAL_PORT);
}

export async function startDesktop(id: string) {
  const sb = await ensureStarted(id);
  await run(
    sb,
    [
      `pgrep -x Xvfb >/dev/null || (nohup Xvfb :0 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &)`,
      `sleep 1`,
      `pgrep -x xfce4-session >/dev/null || (DISPLAY=:0 nohup startxfce4 >/tmp/xfce.log 2>&1 &)`,
      `pgrep -x x11vnc >/dev/null || (nohup x11vnc -display :0 -forever -nopw -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &)`,
      `curl -s -o /dev/null localhost:${VNC_PORT} || (nohup websockify --web /usr/share/novnc ${VNC_PORT} localhost:5900 >/tmp/ws.log 2>&1 &)`,
      `sleep 2`,
    ].join("; "),
    // Checks use exact process names or the port: `pgrep -f` would match this shell's own
    // command line, which names every process it is about to start.
  );
  touch(id);
  // The noVNC client runs in the app (see /desktop/[id]); only its websocket goes to the
  // sandbox. Modal's proxy reads the token from the URL, and the browser doesn't carry it to
  // the sub-resources of a page served from the sandbox, so serving vnc.html there can't work.
  const cred = await sb.createConnectToken({ port: VNC_PORT });
  return withToken(cred.url.replace(/^http/, "ws"), cred.token, "/websockify");
}

export async function stopDesktop(id: string) {
  const sb = await workspaceSandbox(id);
  await run(sb, `pkill -f "[w]ebsockify --we[b]"; pkill -x x11vnc; pkill -x xfce4-session; pkill -x Xvfb; true`);
}

export async function diff(id: string) {
  const sb = await ensureStarted(id);
  touch(id);
  const out = await run(
    sb,
    `cd ${WORKSPACE_ROOT} && for d in */.git; do r=\${d%/.git}; git -C "$r" diff HEAD --no-color --src-prefix="a/$r/" --dst-prefix="b/$r/"; git -C "$r" ls-files --others --exclude-standard | sed "s#^#?? $r/#"; done`,
    { timeout: 120 },
  );
  return out.output;
}
