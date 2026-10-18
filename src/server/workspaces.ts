import { nanoid } from "nanoid";
import { db, now } from "./db";
import { remote, waitForRemote, forgetRemote, forwardPort, setInstanceRegion, run, mustRun, q, WORKSPACE_ROOT, HOME, TERMINAL_PORT, VNC_PORT, type Remote } from "./remote";
import { awsRegion } from "./aws/config";
import { machine, MARKETS, DISK_GB_STEPS, type Machine, type Market } from "./aws/machines";
import {
  launchInstance,
  startInstance,
  stopInstance,
  terminateInstance,
  describeInstance,
  waitForState,
  spotInterrupted,
  rootVolumeGb,
  type InstanceInfo,
} from "./aws/ec2";
import { githubToken, gitIdentity } from "./secrets";

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
  /** 1 when the instance was launched with hibernation, so pause keeps RAM. */
  hibernate: number;
  instance_started_at: number | null;
  /** The root volume's real size in GiB, including room for RAM when hibernating. */
  disk_gb: number | null;
  disk_used_mb: number | null;
  idle_minutes: number;
  loadout: string;
  loadout_applied_hash: string | null;
  created_at: number;
  last_activity_at: number;
  /** NOT NULL legacy column; holds the instance type. */
  snapshot: string;
  /** @deprecated Modal era, no longer read. */
  sandbox_id: string | null;
  /** @deprecated Modal era, no longer read. */
  image_id: string | null;
  /** @deprecated Modal era, no longer read. */
  sandbox_started_at: number | null;
  /** @deprecated Modal era, no longer read. */
  cpu: number | null;
  /** @deprecated Modal era, no longer read. */
  memory_mib: number | null;
  /** @deprecated Modal era, no longer read. */
  gpu: string | null;
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
  if (w.instance_id && w.region) setInstanceRegion(w.instance_id, w.region);
  return w;
}

export function listRepos(workspaceId: string): Repo[] {
  return db().prepare("SELECT * FROM repos WHERE workspace_id = ? ORDER BY name").all(workspaceId) as Repo[];
}

/** The row for the API: legacy Modal columns dropped, the machine spec added (null for Modal-era rows). */
export function workspaceJson(w: Workspace) {
  const { sandbox_id, image_id, sandbox_started_at, cpu, memory_mib, gpu, ...rest } = w;
  void [sandbox_id, image_id, sandbox_started_at, cpu, memory_mib, gpu];
  return { ...rest, machine: machineOf(w) };
}

function machineOf(w: Workspace): Machine | null {
  try {
    return w.instance_type ? machine(w.instance_type) : null;
  } catch {
    return null;
  }
}

function setState(id: string, state: string, error: string | null = null) {
  db().prepare("UPDATE workspaces SET state = ?, error = ? WHERE id = ?").run(state, error, id);
}

const regionOf = (w: Workspace) => w.region ?? awsRegion();

export async function workspaceRemote(id: string): Promise<Remote> {
  const w = getWorkspace(id);
  if (!w.instance_id || (w.state !== "started" && w.state !== "setting up")) throw new Error("Workspace isn't running");
  return remote(w.instance_id);
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

export function createWorkspace(input: {
  name: string;
  instanceType: string;
  market: Market;
  diskGb: number;
  idleMinutes: number;
  repos: string[];
  loadout: string[];
}) {
  const repos = input.repos.filter(Boolean).map(parseRepo); // validate before creating anything
  machine(input.instanceType);
  if (!MARKETS.includes(input.market)) throw new Error(`Market must be one of ${MARKETS.join(", ")}`);
  if (!DISK_GB_STEPS.includes(input.diskGb)) throw new Error(`Disk must be one of ${DISK_GB_STEPS.join(", ")} GB`);
  const id = nanoid(10);
  const t = now();
  db()
    .prepare(
      `INSERT INTO workspaces (id, name, state, snapshot, instance_type, market, region, disk_gb, idle_minutes, loadout, created_at, last_activity_at)
       VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.instanceType, input.instanceType, input.market, awsRegion(), input.diskGb, input.idleMinutes, JSON.stringify(input.loadout), t, t);
  for (const { url, name } of repos) {
    db().prepare("INSERT INTO repos (id, workspace_id, name, url, state) VALUES (?, ?, ?, ?, 'pending')").run(nanoid(10), id, name, url);
  }
  void provision(id);
  return getWorkspace(id);
}

/** Bootstrap failures get their own state so syncState can't paper over them. */
export const SETUP_FAILED = "setup failed";

const MODAL_ERA = "Created on Modal, which this version no longer supports. Delete it.";

/** Workspaces with an EC2 call in flight in this process; syncState leaves those alone. */
const inflight = new Set<string>();

async function guarded<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (inflight.has(id)) throw new Error("Workspace is busy with another start or stop. Try again in a moment.");
  inflight.add(id);
  try {
    return await fn();
  } finally {
    inflight.delete(id);
  }
}

/** The disk size the user picked: a launched row's disk_gb also holds the hibernation room. */
function requestedDiskGb(w: Workspace, m: Machine): number {
  const size = w.disk_gb ?? 50;
  return w.instance_id && w.hibernate ? size - rootVolumeGb(m, 0) : size;
}

/** Launch a new instance, or reuse the one a failed setup left behind. */
async function bootInstance(w: Workspace): Promise<string> {
  const region = regionOf(w);
  const existing = w.instance_id ? await describeInstance(w.instance_id, region) : null;
  if (existing && existing.state !== "terminated" && existing.state !== "shutting-down") {
    if (existing.state === "stopping") await waitForState(w.instance_id!, "stopped", { region });
    if (existing.state === "stopping" || existing.state === "stopped") await startInstance(w.instance_id!, region);
    return w.instance_id!;
  }
  const m = machine(w.instance_type!);
  const l = await launchInstance({ workspaceId: w.id, machine: m, market: (w.market ?? "on-demand") as Market, diskGb: requestedDiskGb(w, m), region });
  db()
    .prepare("UPDATE workspaces SET instance_id = ?, az = ?, region = ?, hibernate = ?, disk_gb = ?, instance_started_at = ? WHERE id = ?")
    .run(l.instanceId, l.az, region, l.hibernate ? 1 : 0, l.volumeGb, now(), w.id);
  // Deleted while RunInstances was in flight: nothing else knows about this instance.
  if (!db().prepare("SELECT 1 FROM workspaces WHERE id = ?").get(w.id)) {
    await terminateInstance(l.instanceId, region);
    throw new Error("Workspace was deleted during setup");
  }
  return l.instanceId;
}

async function provision(id: string) {
  try {
    await guarded(id, async () => {
      const w = getWorkspace(id);
      if (!w.instance_type) throw new Error(MODAL_ERA);
      setState(id, "creating");
      const instanceId = await bootInstance(w);
      setInstanceRegion(instanceId, regionOf(w));
      await waitForState(instanceId, "running", { region: regionOf(w) });
      setState(id, "setting up");
      await bootstrap(await waitForRemote(instanceId));
      setState(id, "started");
    });
    for (const repo of listRepos(id)) if (repo.state !== "ready") await cloneRepo(id, repo.id);
  } catch (err) {
    setState(id, SETUP_FAILED, String(err instanceof Error ? err.message : err));
  }
}

export function retrySetup(id: string) {
  if (getWorkspace(id).state !== SETUP_FAILED) throw new Error("Workspace setup hasn't failed");
  void provision(id);
}

/**
 * Idempotent machine setup. The AMI ships Claude Code, gh and ttyd, so on a fresh image this
 * only verifies them, then sets git identity, GitHub auth and Claude's onboarding flag.
 */
export async function bootstrap(r: Remote) {
  await mustRun(r, `mkdir -p ${WORKSPACE_ROOT} ${HOME}/.claude`);
  await mustRun(r, `command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash`, { timeout: 900 });
  await run(r, `command -v gh >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh)`, { timeout: 900 });
  await run(
    r,
    `command -v ttyd >/dev/null || (curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$(uname -m) && chmod +x /usr/local/bin/ttyd)`,
    { timeout: 300 },
  );
  const id = gitIdentity();
  if (id.name) await run(r, `git config --global user.name ${q(id.name)}`);
  if (id.email) await run(r, `git config --global user.email ${q(id.email)}`);
  const token = githubToken();
  if (token) {
    await run(r, `printf %s "$CS_GH_TOKEN" | gh auth login --with-token && gh auth setup-git`, { env: { CS_GH_TOKEN: token } });
  }
  // Skip Claude's first-run onboarding in the terminal.
  await run(r, `test -f ~/.claude.json || echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > ~/.claude.json`);
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
    const r = await ensureStarted(workspaceId);
    const dest = `${WORKSPACE_ROOT}/${repo.name}`;
    await mustRun(r, `test -d ${q(dest)}/.git || git clone ${q(repo.url)} ${q(dest)}`, { timeout: 1800 });
    const branch = (await run(r, `git -C ${q(dest)} rev-parse --abbrev-ref HEAD`)).output.trim();
    db().prepare("UPDATE repos SET branch = ? WHERE id = ?").run(branch, repoId);
    setRepo("ready");
  } catch (err) {
    setRepo("error", String(err instanceof Error ? err.message : err));
  }
}

export type RepoRisk = { repo: string; dirty: string[]; unpushed: string[]; stashes: number };

/** Work that exists only in the workspace and would be lost if it is deleted. */
export async function unsavedWork(workspaceId: string, onlyRepo?: string): Promise<RepoRisk[]> {
  const r = await workspaceRemote(workspaceId);
  const out = (await run(r, `cd ${WORKSPACE_ROOT} 2>/dev/null && ls -d */.git 2>/dev/null | sed 's#/.git##'`)).output;
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean).filter((n) => onlyRepo === undefined || n === onlyRepo);
  const risks: RepoRisk[] = [];
  for (const name of names) {
    const dir = q(`${WORKSPACE_ROOT}/${name}`);
    const dirty = (await run(r, `git -C ${dir} status --porcelain`)).output.split("\n").filter(Boolean);
    const unpushed = (await run(r, `git -C ${dir} log --branches --not --remotes --oneline`)).output.split("\n").filter(Boolean);
    const stashes = (await run(r, `git -C ${dir} stash list`)).output.split("\n").filter(Boolean).length;
    if (dirty.length || unpushed.length || stashes) risks.push({ repo: name, dirty, unpushed, stashes });
  }
  return risks;
}

export async function removeRepo(workspaceId: string, repoId: string) {
  const repo = db().prepare("SELECT * FROM repos WHERE id = ? AND workspace_id = ?").get(repoId, workspaceId) as Repo | undefined;
  if (!repo) throw new Error(`Repo ${repoId} not found`);
  const r = await workspaceRemote(workspaceId);
  // Rows saved before names were validated can hold "" or "..": drop the row, never the folder.
  try {
    assertRepoName(repo.name);
  } catch {
    db().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    return;
  }
  await run(r, `rm -rf ${q(`${WORKSPACE_ROOT}/${repo.name}`)}`);
  db().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
}

// ---- Lifecycle --------------------------------------------------------------

const SPOT_RECLAIMED = "AWS reclaimed the spot capacity and stopped this workspace. Files were kept; start it again when capacity returns.";
const TERMINATED = "The instance was terminated outside Codespace, so its disk is gone. Delete this workspace.";

/** Start (or wait out a start already under way) and return a connection once sshd answers. */
async function start(id: string): Promise<Remote> {
  return guarded(id, async () => {
    const w = getWorkspace(id);
    if (!w.instance_type) throw new Error(MODAL_ERA);
    if (!w.instance_id) throw new Error("Workspace has no instance. Retry setup.");
    const region = regionOf(w);
    setState(id, "starting");
    try {
      let info = await describeInstance(w.instance_id, region);
      if (!info || info.state === "terminated" || info.state === "shutting-down") throw new Error(TERMINATED);
      if (info.state === "stopping") info = await waitForState(w.instance_id, "stopped", { region });
      if (info.state === "stopped") await startInstance(w.instance_id, region);
      await waitForState(w.instance_id, "running", { region });
      const r = await waitForRemote(w.instance_id);
      db().prepare("UPDATE workspaces SET instance_started_at = ? WHERE id = ?").run(now(), id);
      setState(id, "started");
      return r;
    } catch (err) {
      await reconcile(getWorkspace(id), err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

/** Pause hibernates when the instance was launched for it (RAM survives); otherwise both are a plain stop. */
async function stop(id: string, hibernate: boolean) {
  await guarded(id, async () => {
    const w = getWorkspace(id);
    if (!w.instance_id) return;
    const region = regionOf(w);
    setState(id, "stopping");
    try {
      forgetRemote(w.instance_id);
      await stopInstance(w.instance_id, { hibernate: hibernate && w.hibernate === 1 }, region);
      await waitForState(w.instance_id, "stopped", { region });
      db().prepare("UPDATE workspaces SET instance_started_at = NULL WHERE id = ?").run(id);
      setState(id, "stopped");
    } catch (err) {
      await reconcile(getWorkspace(id), err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

export async function lifecycle(id: string, action: "start" | "pause" | "stop") {
  try {
    if (action === "start") {
      const w = await syncState(id);
      if (w.state !== "started") await start(id);
    } else await stop(id, action === "pause");
  } catch (err) {
    // start/stop already recorded EC2's real state with the message; only fill in what they couldn't.
    const w = getWorkspace(id);
    if (!w.error) setState(id, w.state === "started" || w.state === "stopped" ? w.state : "error", String(err instanceof Error ? err.message : err));
  }
}

export async function deleteWorkspace(id: string) {
  const w = getWorkspace(id);
  if (w.instance_id) {
    forgetRemote(w.instance_id);
    await terminateInstance(w.instance_id, regionOf(w));
  }
  db().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

export async function setIdleMinutes(id: string, minutes: number) {
  db().prepare("UPDATE workspaces SET idle_minutes = ? WHERE id = ?").run(minutes, id);
}

/** Provisioning owns these states; a failed setup stays put until retried. */
const SETUP_STATES = ["creating", "setting up", SETUP_FAILED];

/** Write EC2's view of the instance into the row. `error` overrides the message for a failed action. */
async function reconcile(w: Workspace, error: string | null = null, info?: InstanceInfo | null): Promise<Workspace> {
  if (!w.instance_id) return w;
  info = info === undefined ? await describeInstance(w.instance_id, regionOf(w)) : info;
  const keep = (s: string) => (w.state === s ? w.error : null); // e.g. the spot message on a stopped row
  if (!info || info.state === "terminated" || info.state === "shutting-down") {
    forgetRemote(w.instance_id);
    setState(w.id, "error", TERMINATED);
  } else if (info.state === "running") {
    setState(w.id, "started", error);
  } else if (info.state === "pending") {
    setState(w.id, "starting", error);
  } else if (info.state === "stopping") {
    forgetRemote(w.instance_id);
    setState(w.id, "stopping", error);
  } else {
    forgetRemote(w.instance_id);
    if (w.instance_started_at) db().prepare("UPDATE workspaces SET instance_started_at = NULL WHERE id = ?").run(w.id);
    setState(w.id, "stopped", error ?? (spotInterrupted(info) ? SPOT_RECLAIMED : keep("stopped")));
  }
  return getWorkspace(w.id);
}

/** Notice what happened to the instance without us: spot reclaims, a console stop, termination. */
export async function syncState(id: string) {
  const w = getWorkspace(id);
  if (!w.instance_type || !w.instance_id || SETUP_STATES.includes(w.state) || inflight.has(id)) return w;
  try {
    return await reconcile(w);
  } catch (err) {
    console.error(`[syncState ${id}]`, err); // AWS unreachable or credentials expired: show the last known state
    return w;
  }
}

/** Make sure the instance is running before using it, starting it if needed. */
export async function ensureStarted(id: string): Promise<Remote> {
  const w = await syncState(id);
  if (!w.instance_type) throw new Error(MODAL_ERA);
  if (w.state === SETUP_FAILED) throw new Error(`Workspace setup failed: ${w.error ?? "unknown error"}. Retry setup first.`);
  if ((w.state === "started" || w.state === "setting up") && w.instance_id) return remote(w.instance_id);
  if (w.state === "error" && w.error === TERMINATED) throw new Error(TERMINATED);
  if (SETUP_STATES.includes(w.state) || inflight.has(id)) throw new Error(`Workspace is ${w.state}. Try again in a moment.`);
  return start(id);
}

// ---- Activity and the idle reaper ------------------------------------------

/** Record user or agent activity. The reaper below reads it. */
export function touch(id: string) {
  db().prepare("UPDATE workspaces SET last_activity_at = ? WHERE id = ?").run(now(), id);
}

const DISK_CHECK_MS = 5 * 60_000;
let lastDiskCheck = 0;

/** Record how much of its root volume each running workspace uses; the UI warns as it fills. */
async function checkDisk(running: Workspace[]) {
  if (now() - lastDiskCheck < DISK_CHECK_MS) return;
  lastDiskCheck = now();
  for (const w of running) {
    try {
      const r = await remote(w.instance_id!);
      const used = parseInt((await run(r, `df -BM --output=used / | tail -1`, { timeout: 60 })).output.trim(), 10);
      if (Number.isFinite(used)) db().prepare("UPDATE workspaces SET disk_used_mb = ? WHERE id = ?").run(used, w.id);
    } catch {}
  }
}

async function reap() {
  const rows = db().prepare("SELECT * FROM workspaces WHERE state = 'started' AND instance_id IS NOT NULL").all() as Workspace[];
  const running: Workspace[] = [];
  for (const w of rows) {
    // Catches spot reclaims and console stops within a minute, even with no one looking.
    const synced = await syncState(w.id).catch(() => w);
    if (synced.state === "started") running.push(synced);
  }
  await checkDisk(running);
  for (const w of running) {
    const busy = db().prepare("SELECT 1 FROM threads WHERE workspace_id = ? AND status IN ('starting', 'running', 'waiting')").get(w.id);
    const idle = now() - w.last_activity_at > w.idle_minutes * 60_000;
    if (idle && !busy) await lifecycle(w.id, "pause");
  }
}

const g = globalThis as unknown as { __csReaper?: NodeJS.Timeout };
if (!g.__csReaper) {
  g.__csReaper = setInterval(() => void reap().catch((err) => console.error("[reaper]", err)), 60_000);
  g.__csReaper.unref();
}

// ---- Ports, terminal, desktop and diff --------------------------------------

/** A local port on this Mac that tunnels to `port` on the instance. */
async function localPort(id: string, port: number): Promise<number> {
  await ensureStarted(id);
  touch(id);
  return forwardPort(getWorkspace(id).instance_id!, port);
}

export async function previewUrl(id: string, port: number) {
  return `http://127.0.0.1:${await localPort(id, port)}/`;
}

export async function terminalUrl(id: string) {
  const r = await ensureStarted(id);
  await run(r, `pgrep -x ttyd >/dev/null || (cd ${WORKSPACE_ROOT} && nohup ttyd -p ${TERMINAL_PORT} -W bash >/tmp/ttyd.log 2>&1 &)`);
  await new Promise((res) => setTimeout(res, 500));
  return previewUrl(id, TERMINAL_PORT);
}

export async function startDesktop(id: string) {
  const r = await ensureStarted(id);
  await run(
    r,
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
  // The noVNC client runs in the app (see /desktop/[id]); only its websocket goes to the instance.
  return `ws://127.0.0.1:${await localPort(id, VNC_PORT)}/websockify`;
}

export async function stopDesktop(id: string) {
  const r = await workspaceRemote(id);
  await run(r, `pkill -f "[w]ebsockify --we[b]"; pkill -x x11vnc; pkill -x xfce4-session; pkill -x Xvfb; true`);
}

export async function diff(id: string) {
  const r = await ensureStarted(id);
  touch(id);
  const out = await run(
    r,
    `cd ${WORKSPACE_ROOT} && for d in */.git; do r=\${d%/.git}; git -C "$r" diff HEAD --no-color --src-prefix="a/$r/" --dst-prefix="b/$r/"; git -C "$r" ls-files --others --exclude-standard | sed "s#^#?? $r/#"; done`,
    { timeout: 120 },
  );
  return out.output;
}
