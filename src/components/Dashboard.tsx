"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { AwsStatus } from "@/server/aws/config";
import { api, diskUse, QUOTA_FAMILIES, regionSummary, RESTORE_HINT, dollars, gpuShare, machineLabel, timeAgo, type MachinesInfo, type Market, type RegionStatus, type Thread, type Workspace } from "@/lib/api";
import { bestSpot, estimate, InstancePicker, overQuota, RegionPicker, regionBlocker, resolveCheapest } from "./InstancePicker";
import { ThreadSquares } from "./ThreadSquares";
import type { PermissionEvent } from "./composer/model";
import { Button, ColdTag, FOCUS, Icon, Input, Logo, MarketTag, Modal, Segmented, StateDot } from "./ui";
import { DeleteWorkspace } from "./DeleteFlow";
import { InstructionsEditor } from "./InstructionsEditor";
import { RepoChips, repoSpec, type RepoChoice } from "./RepoPicker";

type Settings = {
  aws: AwsStatus & { regions: RegionStatus[] };
  claude: boolean;
  github: boolean;
  ssmPlugin: boolean;
  /** Stopped workspaces move to cold storage after this many days; 0 = never. */
  coldAfterDays: number;
};

/** AWS is usable with working credentials, the SSM plugin, and the infra stack in at least one region. */
const awsReady = (s: Settings) => s.aws.ok && s.aws.regions.some((r) => regionSummary(r).usable) && s.ssmPlugin;
type Attention = { thread: Thread & { workspace_name: string }; pending: PermissionEvent[] };

export function Dashboard() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [attention, setAttention] = useState<Attention[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");

  const load = useCallback(() => {
    api<Workspace[]>("/api/workspaces").then(setWorkspaces).catch(() => setWorkspaces([]));
    api<Attention[]>("/api/attention").then(setAttention).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    api<Settings>("/api/settings").then((s) => {
      setSettings(s);
      if (!awsReady(s) || !s.claude) setSettingsOpen(true);
    });
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id: string, action: "start" | "stop") => {
    // A 409 means another action is already running; other failures land on the row's error.
    await api(`/api/workspaces/${id}/action`, { method: "POST", json: { action } }).catch(() => {});
    load();
  };

  const shown = (workspaces ?? []).filter((w) => filter === "all" || (filter === "running" ? w.state === "started" : w.state !== "started"));

  return (
    <div className="min-h-screen">
      <header className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <Logo />
        <span className="text-[15px] font-semibold">grogan.codes</span>
        <div className="ml-auto flex items-center gap-3.5 text-xs text-muted">
          {settings && (
            <button onClick={() => setSettingsOpen(true)} className="flex gap-3.5 hover:text-text" title="Settings">
              {(
                [
                  ["AWS", awsReady(settings)],
                  ["Claude", settings.claude],
                  ["GitHub", settings.github],
                ] as const
              ).map(([k, ok]) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span className={`size-[7px] rounded-full ${ok ? "bg-ok" : "bg-bad"}`} />
                  {k}
                </span>
              ))}
            </button>
          )}
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New workspace
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-9 px-4 py-9 sm:px-6">
        {attention.length > 0 && (
          <section aria-labelledby="needs" className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 id="needs" className="text-[28px] font-bold tracking-tight">
                {attention.length} {attention.length === 1 ? "thread needs" : "threads need"} you
              </h1>
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))]">
              {attention.map((a) => (
                <AttentionCard key={a.thread.id} a={a} onDone={load} />
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="wslabel" className="rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <h2 id="wslabel" className="text-[15px] font-semibold">
              Workspaces
            </h2>
            <Segmented
              className="ml-auto"
              label="Filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "running", label: "Running" },
                { value: "stopped", label: "Stopped" },
              ]}
            />
          </div>

          {workspaces === null ? (
            <p className="border-t border-line px-5 py-8 text-muted">Loading…</p>
          ) : workspaces.length === 0 ? (
            <div className="border-t border-line px-5 py-12 text-center text-muted">
              No workspaces yet.{" "}
              <button className="text-accent underline" onClick={() => setCreating(true)}>
                Create one
              </button>
              .
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,2.6fr)_minmax(0,1.2fr)_96px_32px] gap-5 border-t border-line px-5 py-2 md:grid">
                <span className="label">Workspace</span>
                <span className="label">Threads</span>
                <span className="label">Instance · disk</span>
              </div>
              {shown.map((w) => (
                <WorkspaceRow key={w.id} w={w} onAct={act} onDelete={() => setDeleting(w)} />
              ))}
            </>
          )}
        </section>
      </main>

      {creating && <NewWorkspace onClose={() => setCreating(false)} onCreated={() => (setCreating(false), load())} />}
      {settingsOpen && settings && (
        <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} onSaved={() => api<Settings>("/api/settings").then(setSettings)} />
      )}
      {deleting && <DeleteWorkspace id={deleting.id} name={deleting.name} archived={deleting.archived} onClose={() => setDeleting(null)} onDone={() => (setDeleting(null), load())} />}
    </div>
  );
}

function WorkspaceRow({ w, onAct, onDelete }: { w: Workspace; onAct: (id: string, a: "start" | "stop") => void; onDelete: () => void }) {
  const live = w.state === "started";
  const a = w.activity;
  return (
    <div className="grid grid-cols-1 items-center gap-2.5 border-t border-panel-3 px-5 py-4 hover:bg-panel-2 md:grid-cols-[minmax(0,2.2fr)_minmax(0,2.6fr)_minmax(0,1.2fr)_96px_32px] md:gap-5">
      <Link href={`/w/${w.id}`} className="flex min-w-0 items-center gap-3">
        <span
          className={`size-2.5 shrink-0 rounded-full ${
            live ? "bg-accent shadow-[0_0_0_4px_rgba(200,242,90,.14)]" : w.state === "error" || w.state === "setup failed" ? "bg-bad" : /ing$/.test(w.state) ? "animate-pulse bg-warn" : "border-2 border-faint"
          }`}
        />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">{w.name}</span>
          <span className="block truncate font-mono text-xs text-muted">{w.repos.length ? w.repos.map((r) => r.name).join(" · ") : "blank workspace"}</span>
        </span>
      </Link>
      <div className="flex min-w-0 flex-col gap-1.5">
        <ThreadSquares workspaceId={w.id} threads={a?.threads ?? []} />
        {w.error && (
          <span className="truncate text-xs text-bad" title={w.error}>
            {w.error}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 text-xs">
        <span className={`truncate font-mono ${live ? "text-text-2" : "text-faint"}`} title={machineLabel(w)}>
          {w.instance_type ?? "no instance"}
          {w.machine && !w.machine.gpu && (
            <span className="text-faint">
              {" "}
              · {w.machine.vcpu} vCPU · {w.machine.memoryGib} GiB
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {w.machine?.gpu && (
            <span className="rounded-md bg-[#2a2340] px-1.5 py-px font-mono text-[11px] font-semibold text-[#cdbbff]">
              {gpuShare(w.machine.gpu)} {w.machine.gpu.vramGb} GB
            </span>
          )}
          {w.archived && <ColdTag archivedAt={w.archived_at} />}
          {w.market && <MarketTag market={w.market} />}
          {w.region && <span className="font-mono text-[11px] text-faint">{w.region}</span>}
        </span>
        <DiskBar w={w} />
      </div>
      {live ? (
        <Link href={`/w/${w.id}`} className="inline-flex h-8 w-24 items-center justify-center rounded-lg border border-line-2 bg-panel-3 text-[13px] font-medium hover:border-faint">
          Open
        </Link>
      ) : (
        <Button
          className="w-24 justify-center"
          title={w.archived ? RESTORE_HINT : undefined}
          onClick={() => onAct(w.id, "start")}
          disabled={/ing$/.test(w.state) || !w.instance_type}
        >
          <Icon name="play" size={12} />
          Start
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label={`Delete ${w.name}`} title="Delete" onClick={onDelete}>
        <Icon name="x" />
      </Button>
    </div>
  );
}

/** Root volume use; amber past 80%, red past 95%. A full disk breaks git and Claude, so it shows early. */
function DiskBar({ w }: { w: Workspace }) {
  const use = diskUse(w);
  if (use === null) return null;
  const tone = use > 0.95 ? "bg-bad" : use > 0.8 ? "bg-warn" : "bg-info";
  return (
    <div title={`Disk ${(w.disk_used_mb! / 1024).toFixed(1)} of ${w.disk_gb} GB`} className="h-1 max-w-[120px] rounded bg-line">
      <div className={`h-1 rounded ${tone}`} style={{ width: `${Math.min(100, Math.round(use * 100))}%` }} />
    </div>
  );
}

function summary(e: PermissionEvent): string {
  const i = e.input ?? {};
  return String(i.command ?? i.file_path ?? i.url ?? i.pattern ?? i.description ?? e.description ?? e.toolName);
}

function AttentionCard({ a, onDone }: { a: Attention; onDone: () => void }) {
  const e = a.pending[0];
  const question = e.toolName === "AskUserQuestion";
  const plan = e.toolName === "ExitPlanMode";
  const href = `/w/${a.thread.workspace_id}?thread=${a.thread.id}`;
  const respond = async (result: unknown) => {
    await api(`/api/threads/${a.thread.id}/respond`, { method: "POST", json: { requestId: e.requestId, result } });
    onDone();
  };
  const tone = question ? "border-[#2a3a52] bg-[#0f141b]" : "border-[#5a4a26] bg-[#1a170f]";
  return (
    <div className={`flex flex-col gap-3 rounded-2xl border p-4 ${tone}`}>
      <div className={`flex items-center gap-2 text-xs ${question ? "text-[#9db3cc]" : "text-[#c9b58a]"}`}>
        <span className={`font-semibold ${question ? "text-info" : "text-warn"}`}>{question ? "Question" : plan ? "Plan review" : "Approval"}</span>
        <span>·</span>
        <span className="truncate font-mono">
          {a.thread.workspace_name}
          {a.thread.repo ? ` / ${a.thread.repo}` : ""}
        </span>
        <span className="ml-auto shrink-0">{timeAgo(a.thread.updated_at)}</span>
      </div>
      <div className="text-[15px] font-semibold">{a.thread.title}</div>
      {question ? (
        <div className="leading-relaxed text-text-2">{e.input?.questions?.[0]?.question ?? "Claude has a question."}</div>
      ) : plan ? (
        <div className="line-clamp-3 leading-relaxed text-text-2">{String(e.input?.plan ?? "Claude has a plan ready for review.")}</div>
      ) : (
        <div className="truncate rounded-lg border border-[#2f2a1c] bg-bg px-3 py-2 font-mono text-[13px] text-[#ffe2ae]" title={summary(e)}>
          <span className="text-faint">{e.toolName} </span>
          {summary(e)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!question && !plan && (
          <>
            <Button variant="attn" onClick={() => respond({ behavior: "allow", updatedInput: e.input })}>
              Allow once
            </Button>
            <Button onClick={() => respond({ behavior: "deny", message: "User denied" })}>Deny</Button>
          </>
        )}
        <Link href={href} className="ml-auto inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-panel-3 hover:text-text">
          {question || plan ? "Answer in thread →" : "Open thread →"}
        </Link>
      </div>
    </div>
  );
}

function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [info, setInfo] = useState<MachinesInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [type, setType] = useState("");
  const [market, setMarket] = useState<Market>("on-demand");
  const [region, setRegion] = useState("auto");
  const [diskGb, setDiskGb] = useState(0);
  const [idle, setIdle] = useState(30);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MachinesInfo>("/api/machines")
      .then((i) => {
        setInfo(i);
        setType(i.defaultType);
        setDiskGb(i.defaultDiskGb);
      })
      .catch((e) => setInfoError(String(e instanceof Error ? e.message : e)));
  }, []);

  const selected = info?.machines.find((m) => m.type === type);
  // The region the workspace would land in, as far as the client can tell.
  const landing = selected && info ? (region === "auto" ? resolveCheapest(info, selected, market) : region) : null;
  const named = info?.regions.find((r) => r.region === region);
  const blocker = selected && info && named ? regionBlocker(named, selected, info, market) : null;
  const cost = selected && info ? estimate(selected, market, diskGb, landing ? info.spot[landing]?.[selected.type] : undefined) : null;
  const best = selected && info ? bestSpot(info, selected) : null;
  // Why Create is disabled, shown next to the button (a disabled button can't show a tooltip).
  const why = !info
    ? infoError
      ? "Instance types didn't load"
      : "Loading instance types…"
    : !selected
      ? "Nothing matches the instance filters"
      : blocker
        ? `${region} can't run ${selected.type}`
        : !landing
          ? overQuota(info, selected, market)
            ? `${selected.type} is over your ${market} vCPU quota in every region (Settings → Quotas)`
            : `No region can run ${selected.type} yet`
          : !name.trim()
            ? "Name the workspace"
            : "";
  const ready = !why && !busy;


  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const all = repos.map(repoSpec);
      await api("/api/workspaces", {
        method: "POST",
        // No loadout: the server gives new workspaces every catalog item; trim it in the workspace.
        json: { name, instanceType: type, market, region, diskGb, idleMinutes: idle, repos: all },
      });
      onCreated();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title="New workspace" onClose={onClose} wide>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void create();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) void create();
        }}
      >
        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                className="h-11 rounded-[10px] border border-line-2 bg-panel-2 px-3.5 text-base font-semibold outline-none placeholder:font-normal placeholder:text-faint focus:border-accent"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Repos</span>
              <RepoChips value={repos} onChange={setRepos} />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Stop when idle for</span>
              <Segmented
                stretch
                label="Idle timeout"
                value={idle}
                onChange={setIdle}
                className="h-9 [&>button]:h-full"
                options={[10, 15, 30, 60, 120].map((m) => ({ value: m, label: m < 60 ? `${m}m` : `${m / 60}h` }))}
              />
              <span className="text-xs text-faint">Activity is you using the app or a Claude turn running. Files are kept when it stops.</span>
            </div>

            <p className="text-xs leading-relaxed text-faint">
              New workspaces get every plugin, skill, agent, MCP server and instruction from your catalog. Trim them later in the workspace’s Loadout panel.
            </p>
          </div>

          <div className="flex flex-col gap-5">
            {infoError ? (
              <p className="text-xs text-bad">Couldn’t load instance types: {infoError}</p>
            ) : !info ? (
              <p className="text-xs text-muted">Loading instance types…</p>
            ) : (
              <InstancePicker info={info} value={type} market={market} onChange={setType} />
            )}

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Market</span>
              <Segmented
                stretch
                label="Market"
                value={market}
                onChange={setMarket}
                className="h-9 [&>button]:h-full"
                options={[
                  { value: "on-demand", label: "On-demand" },
                  {
                    value: "spot",
                    label: selected && best ? `Spot · −${Math.max(0, Math.round((1 - best.price / selected.onDemandHr) * 100))}%` : "Spot",
                  },
                ]}
              />
              {market === "spot" ? (
                <span className="text-xs leading-relaxed text-muted">
                  Spare capacity at a discount. AWS can reclaim the instance with 2 minutes’ notice. The disk is kept, and CPU types resume from hibernation when you start them
                  again; GPU types come back from a plain stop.
                </span>
              ) : (
                <span className="text-xs text-faint">Full price. Runs until you or the idle timeout stop it.</span>
              )}
            </div>

            {info && selected && (
              <>
                <RegionPicker info={info} m={selected} market={market} value={region} onChange={setRegion} />
                {blocker && (
                  <span className="text-xs text-bad">
                    {region} can’t run {selected.type}: {blocker}.
                  </span>
                )}
              </>
            )}

            {info && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-text-2">Disk</span>
                <Segmented
                  stretch
                  label="Disk size"
                  value={diskGb}
                  onChange={setDiskGb}
                  className="h-9 [&>button]:h-full"
                  options={info.diskSteps.map((g) => ({ value: g, label: `${g} GB` }))}
                />
                <span className="text-xs text-faint">
                  Encrypted gp3, kept while the workspace exists, running or stopped.
                  {selected?.hibernate && ` Hibernation adds ${Math.ceil(selected.memoryGib)} GiB on top for RAM.`}
                </span>
              </div>
            )}
          </div>
        </div>

        {error && <p className="text-bad">{error}</p>}
        <div className="-mx-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-6 pt-4">
          <span className="flex min-w-0 flex-1 flex-col text-[13px] text-muted">
            {selected ? (
              <span className="truncate font-mono text-text">
                {selected.type} · {market} · {region === "auto" ? `cheapest → ${landing ?? "none"}` : region} · {diskGb} GB · {repos.length} {repos.length === 1 ? "repo" : "repos"}
              </span>
            ) : null}
            {cost && (
              <span className="text-xs">
                ≈ {cost.spotKnown ? "" : "≤ "}
                {dollars(cost.totalHr)}/hr running · disk ≈ {dollars(cost.diskMonth)}/mo, also while stopped
                {!cost.spotKnown && " · live spot price unavailable, showing on-demand"}
              </span>
            )}
            {why && !busy && <span className={`text-xs ${name.trim() ? "text-warn" : "text-faint"}`}>{why}</span>}
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {busy ? "Creating…" : "Create workspace"}
            <span className="font-mono text-[11px] opacity-70">⌘↵</span>
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const TONE_DOT = { ok: "ready", warn: "waiting", bad: "error" } as const;

function StatusRow({ tone, label, children }: { tone: "ok" | "warn" | "bad"; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 text-xs">
      <span className="pt-1">
        <StateDot state={TONE_DOT[tone]} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-text-2">{label}</div>
        <div className={`min-w-0 ${tone === "warn" ? "text-warn" : "text-muted"}`}>{children}</div>
      </div>
    </div>
  );
}

function SettingsModal({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [profile, setProfile] = useState(settings.aws.profile ?? "");
  const [regions, setRegions] = useState(settings.aws.regions.map((r) => r.region).join(", "));
  const [claudeToken, setClaudeToken] = useState("");
  const [coldDays, setColdDays] = useState(String(settings.coldAfterDays));
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const { aws, ssmPlugin } = settings;
  const code = "rounded bg-panel-3 px-1 font-mono text-text-2";

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold">AWS</span>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Profile</span>
              <Input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default chain" className="w-full font-mono" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Regions</span>
              <Input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="us-east-1, us-east-2, us-west-2" className="w-full font-mono" />
            </label>
          </div>
          <span className="text-xs text-faint">
            A profile from <code className="font-mono">~/.aws/config</code>; SSO profiles work after <code className="font-mono">aws sso login</code>. Empty uses the default credential
            chain. Regions are where workspaces may run, picked by price; the first is home, where images are built and copied from. Empty uses us-east-1, us-east-2,
            us-west-2.
          </span>
        </div>

        <div className="flex flex-col gap-3 rounded-[10px] border border-line bg-panel-2 p-3">
          <StatusRow tone={aws.ok ? "ok" : "bad"} label="Credentials">
            {aws.ok ? (
              <span className="flex min-w-0 gap-1.5">
                <span className="shrink-0">
                  Account <span className="font-mono text-text-2">{aws.account}</span> ·
                </span>
                <span className="truncate font-mono" title={aws.arn}>
                  {aws.arn}
                </span>
              </span>
            ) : (
              <span className="break-words">{aws.error || "No credentials found."}</span>
            )}
          </StatusRow>
          {aws.regions.map((r, i) => {
            const s = regionSummary(r);
            const deploy = s.text.startsWith("Deploy infra/");
            return (
              <StatusRow key={r.region} tone={s.tone} label={`${r.region}${i === 0 ? " (home)" : ""}`}>
                {deploy ? (
                  <>
                    Deploy <code className={code}>infra/</code> in {r.region} (see infra/README.md).
                    <span className="mt-1 block truncate font-mono text-[11px] text-faint" title={r.missing.join("\n")}>
                      Missing: {r.missing.join(", ")}
                    </span>
                  </>
                ) : (
                  <span className="break-words" title={s.tone === "warn" ? r.missing.join("\n") : undefined}>
                    {s.text}
                  </span>
                )}
              </StatusRow>
            );
          })}
          <StatusRow tone={ssmPlugin ? "ok" : "bad"} label="session-manager-plugin">
            {ssmPlugin ? (
              "Installed. The app reaches instances over SSM, with no open ports."
            ) : (
              <>
                Install it on this Mac: <code className={code}>brew install --cask session-manager-plugin</code>
              </>
            )}
          </StatusRow>
        </div>

        <QuotasSection />

        <div className="flex flex-col gap-1.5">
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            Move stopped workspaces to cold storage after
            <Input type="number" min={0} max={365} step={1} value={coldDays} onChange={(e) => setColdDays(e.target.value)} className="w-20 py-1 font-mono" />
            days
          </label>
          <span className="text-xs text-faint">
            0 = never. Cold storage snapshots the disk and removes the instance, so you pay only for data written (about $0.05/GB-month instead of $0.08 for the whole
            volume). Starting it again takes a few extra minutes.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[13px] font-semibold">Global instructions</span>
          <Button size="sm" className="ml-auto" onClick={() => setInstructionsOpen(true)}>
            Edit instructions
          </Button>
          <span className="w-full text-xs text-faint">Written to ~/.claude/CLAUDE.md in every workspace when a thread starts, above your personal CLAUDE.md.</span>
        </div>
        {instructionsOpen && <InstructionsEditor onClose={() => setInstructionsOpen(false)} />}

        <label className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <StateDot state={settings.claude ? "ready" : "error"} /> Claude subscription token
          </span>
          <Input type="password" value={claudeToken} onChange={(e) => setClaudeToken(e.target.value)} placeholder={settings.claude ? "•••• saved" : "sk-ant-oat01-…"} className="w-full" />
          <span className="text-xs text-faint">
            Run <code className="font-mono">claude setup-token</code> in a terminal and paste the result. Stored in your macOS Keychain (service “codespace”) and passed to Claude
            over SSH, never written to an instance&apos;s disk.
          </span>
        </label>
        <div className="flex items-center gap-2 text-xs">
          <StateDot state={settings.github ? "ready" : "error"} />
          GitHub: {settings.github ? "using your gh CLI login" : "run `gh auth login` on this Mac"}
        </div>
        <div className="flex items-center justify-end gap-2">
          {error && <span className="text-xs text-bad">{error}</span>}
          {phase === "saving" && <span className="text-xs text-muted">Saving and checking…</span>}
          {phase === "saved" && <span className="text-xs text-ok">Saved</span>}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={phase === "saving"}
            onClick={async () => {
              setError("");
              setPhase("saving");
              try {
                await api("/api/settings", { method: "POST", json: { awsProfile: profile, awsRegions: regions, claudeToken, coldAfterDays: coldDays.trim() } });
                await onSaved();
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
                setPhase("idle");
                return;
              }
              setClaudeToken("");
              setPhase("saved");
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const QUOTAS_URL = "https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas";

/** Each region's vCPU limits (in use / limit) per family and market, from /api/machines. */
function QuotasSection() {
  const [quotas, setQuotas] = useState<NonNullable<MachinesInfo["quotas"]> | "error" | null>(null);
  useEffect(() => {
    api<MachinesInfo>("/api/machines")
      .then((i) => setQuotas(i.quotas ?? {}))
      .catch(() => setQuotas("error"));
  }, []);
  const cell = (used: number | undefined, limit: number | undefined) =>
    limit == null ? "?" : (
      <span className={limit === 0 ? "text-faint" : used && used >= limit ? "text-warn" : "text-text-2"} title={`${used ?? 0} of ${limit} vCPU in use`}>
        {used ? `${used}/` : ""}
        {limit}
      </span>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">Quotas</span>
        <span className="text-xs text-faint">vCPU, on-demand / spot</span>
        <a href={QUOTAS_URL} target="_blank" rel="noreferrer" className={`ml-auto rounded text-xs text-accent hover:underline ${FOCUS}`}>
          Service Quotas ↗
        </a>
      </div>
      {quotas === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : quotas === "error" || !Object.keys(quotas).length ? (
        <p className="text-xs text-muted">Couldn’t read quotas. GPU types need the G and VT (or P) limit raised above 0.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,auto)] gap-x-4 gap-y-1 rounded-[10px] border border-line bg-panel-2 px-3 py-2 font-mono text-xs">
          <span />
          {QUOTA_FAMILIES.map((f) => (
            <span key={f.key} className="text-right font-sans text-[11px] text-muted">
              {f.label}
            </span>
          ))}
          {Object.entries(quotas).map(([region, q]) => (
            <Fragment key={region}>
              <span className="text-muted">{region}</span>
              {QUOTA_FAMILIES.map((f) => (
                <span key={f.key} className="text-right">
                  {q ? (
                    <>
                      {cell(q.usage?.[f.key]?.onDemand, q[f.key]?.onDemand)} <span className="text-faint">/</span> {cell(q.usage?.[f.key]?.spot, q[f.key]?.spot)}
                    </>
                  ) : (
                    <span className="text-faint">unknown</span>
                  )}
                </span>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
