"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, CPU_STEPS, DISK_GB_STEPS, diskUse, machineLabel, MEMORY_GB_STEPS, timeAgo, type Thread, type Workspace } from "@/lib/api";
import { Dial } from "./Dial";
import { ThreadSquares } from "./ThreadSquares";
import type { PermissionEvent } from "./composer/model";
import { Button, Icon, Input, Logo, Modal, Segmented, StateDot } from "./ui";
import { LoadoutPicker } from "./LoadoutPicker";
import { DeleteWorkspace } from "./DeleteFlow";

type Settings = { modal: boolean; claude: boolean; github: boolean };
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
      if (!s.modal || !s.claude) setSettingsOpen(true);
    });
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id: string, action: "start" | "stop") => {
    await api(`/api/workspaces/${id}/action`, { method: "POST", json: { action } });
    load();
  };

  const shown = (workspaces ?? []).filter((w) => filter === "all" || (filter === "running" ? w.state === "started" : w.state !== "started"));

  return (
    <div className="min-h-screen">
      <header className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <Logo />
        <span className="text-[15px] font-semibold">Codespace</span>
        <div className="ml-auto flex items-center gap-3.5 text-xs text-muted">
          {settings && (
            <button onClick={() => setSettingsOpen(true)} className="flex gap-3.5 hover:text-text" title="Settings">
              {(["modal", "claude", "github"] as const).map((k) => (
                <span key={k} className="flex items-center gap-1.5 capitalize">
                  <span className={`size-[7px] rounded-full ${settings[k] ? "bg-ok" : "bg-bad"}`} />
                  {k === "github" ? "GitHub" : k}
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
                <span className="label">CPU · RAM · disk</span>
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
      {deleting && <DeleteWorkspace id={deleting.id} name={deleting.name} onClose={() => setDeleting(null)} onDone={() => (setDeleting(null), load())} />}
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
        <span className={`font-mono ${live ? "text-text-2" : "text-faint"}`}>{machineLabel(w)}</span>
        {w.gpu && (
          <span className="flex">
            <span className="rounded-md bg-[#2a2340] px-1.5 py-px font-mono text-[11px] font-semibold text-[#cdbbff]">{w.gpu.replace(/^([^:]+):(\d+)$/, "$2× $1").replace(/^([^:×]+)$/, "1× $1")}</span>
          </span>
        )}
        <DiskBar w={w} />
      </div>
      {live ? (
        <Link href={`/w/${w.id}`} className="inline-flex h-8 w-24 items-center justify-center rounded-lg border border-line-2 bg-panel-3 text-[13px] font-medium hover:border-faint">
          Open
        </Link>
      ) : (
        <Button className="w-24 justify-center" onClick={() => onAct(w.id, "start")} disabled={/ing$/.test(w.state)}>
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

/** Disk quota use; amber past 80%, red past 95%. Modal can't cap disk, so this is the only guard. */
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

const GPUS = ["T4", "L4", "A10G", "L40S", "A100", "A100-80GB", "H100", "H200", "B200"];

function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [repoDraft, setRepoDraft] = useState("");
  const [cpu, setCpu] = useState(4);
  const [memoryGb, setMemoryGb] = useState(8);
  const [diskGb, setDiskGb] = useState(50);
  const [gpu, setGpu] = useState("");
  const [gpuCount, setGpuCount] = useState(1);
  const [idle, setIdle] = useState(30);
  const [loadout, setLoadout] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const addRepo = () => {
    const r = repoDraft.trim().replace(/,$/, "");
    if (r && !repos.includes(r)) setRepos([...repos, r]);
    setRepoDraft("");
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const all = repoDraft.trim() ? [...repos, repoDraft.trim()] : repos;
      await api("/api/workspaces", {
        method: "POST",
        json: { name, machine: { cpu, memoryGb, diskGb }, gpu: gpu ? (gpuCount > 1 ? `${gpu}:${gpuCount}` : gpu) : null, idleMinutes: idle, repos: all, loadout },
      });
      onCreated();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const machine = `${cpu} CPU · ${memoryGb} GB · ${diskGb} GB${gpu ? ` + ${gpuCount}× ${gpu}` : ""}`;
  const QUICK = [
    { label: "Small", cpu: 1, memoryGb: 1, diskGb: 10 },
    { label: "Medium", cpu: 2, memoryGb: 4, diskGb: 20 },
    { label: "Large", cpu: 4, memoryGb: 8, diskGb: 50 },
  ];

  return (
    <Modal title="New workspace" onClose={onClose} wide>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !busy) void create();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && name.trim() && !busy) void create();
        }}
      >
        <div className="grid gap-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
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
              <label htmlFor="repo" className="text-xs font-semibold text-text-2">
                Repos
              </label>
              <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line-2 bg-panel-2 p-2 focus-within:border-accent">
                {repos.map((r) => (
                  <span key={r} className="inline-flex items-center gap-1.5 rounded-[7px] bg-[#23301a] py-1 pr-1.5 pl-2.5 font-mono text-xs text-[#ddf5a0]">
                    {r}
                    <button type="button" aria-label={`Remove ${r}`} onClick={() => setRepos(repos.filter((x) => x !== r))} className="px-0.5">
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="repo"
                  value={repoDraft}
                  onChange={(e) => setRepoDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === ",") {
                      e.preventDefault();
                      addRepo();
                    }
                    if (e.key === "Backspace" && !repoDraft && repos.length) setRepos(repos.slice(0, -1));
                  }}
                  onBlur={addRepo}
                  placeholder={repos.length ? "Add another" : "owner/repo or URL, then Enter"}
                  className="h-7 min-w-40 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-faint"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Loadout</span>
              <LoadoutPicker value={loadout} onChange={setLoadout} />
            </div>
          </div>

          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-text-2">Machine</span>
                <div role="group" aria-label="Quick sizes" className="ml-auto flex gap-1">
                  {QUICK.map((q) => {
                    const on = q.cpu === cpu && q.memoryGb === memoryGb && q.diskGb === diskGb;
                    return (
                      <button
                        key={q.label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => (setCpu(q.cpu), setMemoryGb(q.memoryGb), setDiskGb(q.diskGb))}
                        className={`h-[26px] rounded-full border px-2.5 text-xs font-medium ${on ? "border-text bg-text text-bg" : "border-line-2 text-muted hover:text-text"}`}
                      >
                        {q.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Dial label="CPU" unit="cores" steps={CPU_STEPS} value={cpu} onChange={setCpu} />
                <Dial label="Memory" unit="GB RAM" steps={MEMORY_GB_STEPS} value={memoryGb} onChange={setMemoryGb} />
                <Dial label="Disk" unit="GB" steps={DISK_GB_STEPS} value={diskGb} onChange={setDiskGb} color="var(--info)" />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">GPU</span>
              <div role="radiogroup" aria-label="GPU" className="grid grid-cols-5 gap-1.5">
                {["", ...GPUS].map((g) => {
                  const on = gpu === g;
                  return (
                    <button
                      key={g || "none"}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setGpu(g)}
                      className={`h-[34px] truncate rounded-lg border px-1 text-xs font-semibold ${
                        on ? (g ? "border-gpu bg-[#2a2340] text-text" : "border-faint bg-[#2a2d27] text-text") : `border-line-2 bg-panel-2 hover:border-faint ${g ? "text-text-2" : "text-muted"}`
                      }`}
                    >
                      {g ? g.replace("-80GB", " 80G") : "None"}
                    </button>
                  );
                })}
              </div>
              {gpu && (
                <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[#3a3158] bg-[#13111b] px-2.5 py-2">
                  <div className="flex items-center rounded-[9px] border border-[#2a2540] bg-bg p-0.5">
                    <button type="button" aria-label="Fewer GPUs" onClick={() => setGpuCount(Math.max(1, gpuCount - 1))} className="size-[30px] rounded-[7px] text-base hover:bg-[#2a2d27]">
                      −
                    </button>
                    <span className="min-w-14 text-center font-mono text-[13px]">
                      {gpuCount} {gpuCount === 1 ? "GPU" : "GPUs"}
                    </span>
                    <button type="button" aria-label="More GPUs" onClick={() => setGpuCount(Math.min(8, gpuCount + 1))} className="size-[30px] rounded-[7px] text-base hover:bg-[#2a2d27]">
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-2">Snapshot and stop when idle for</span>
              <Segmented
                stretch
                label="Idle timeout"
                value={idle}
                onChange={setIdle}
                className="h-9 [&>button]:h-full"
                options={[10, 15, 30, 60, 120].map((m) => ({ value: m, label: m < 60 ? `${m}m` : `${m / 60}h` }))}
              />
              {gpu ? (
                <div className="flex gap-2.5 rounded-[10px] border border-[#5a4a26] bg-[#1a170f] px-3 py-2.5 text-xs leading-relaxed text-[#e8d3a6]">
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-md bg-warn text-[11px] font-bold text-bg">!</span>
                  GPU sandboxes can’t take memory snapshots. Codespace saves your files before it stops one, but running processes end.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {error && <p className="text-bad">{error}</p>}
        <div className="-mx-6 flex flex-wrap items-center gap-3 border-t border-line px-6 pt-4">
          <span className="text-[13px] text-muted">
            <span className="font-mono text-text">
              {machine} · {repos.length + (repoDraft.trim() ? 1 : 0)} repos
            </span>
          </span>
          <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create workspace"}
            <span className="font-mono text-[11px] opacity-70">⌘↵</span>
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsModal({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: () => void }) {
  const [modalId, setModalId] = useState("");
  const [modalSecret, setModalSecret] = useState("");
  const [claudeToken, setClaudeToken] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="text-xs text-muted">Stored in your macOS Keychain (service “codespace”). Never written to a sandbox&apos;s disk.</p>
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <StateDot state={settings.modal ? "ready" : "error"} /> Modal token
          </span>
          <div className="flex gap-2">
            <Input aria-label="Modal token ID" value={modalId} onChange={(e) => setModalId(e.target.value)} placeholder={settings.modal ? "•••• saved" : "ak-…"} className="w-full" />
            <Input aria-label="Modal token secret" type="password" value={modalSecret} onChange={(e) => setModalSecret(e.target.value)} placeholder={settings.modal ? "•••• saved" : "as-…"} className="w-full" />
          </div>
          <span className="text-xs text-faint">
            modal.com → Settings → API tokens. Leave empty to use <code className="font-mono">~/.modal.toml</code> from <code className="font-mono">modal setup</code>.
          </span>
        </div>
        <label className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <StateDot state={settings.claude ? "ready" : "error"} /> Claude subscription token
          </span>
          <Input type="password" value={claudeToken} onChange={(e) => setClaudeToken(e.target.value)} placeholder={settings.claude ? "•••• saved" : "sk-ant-oat01-…"} className="w-full" />
          <span className="text-xs text-faint">
            Run <code className="font-mono">claude setup-token</code> in a terminal and paste the result.
          </span>
        </label>
        <div className="flex items-center gap-2 text-xs">
          <StateDot state={settings.github ? "ready" : "error"} />
          GitHub: {settings.github ? "using your gh CLI login" : "run `gh auth login` on this Mac"}
        </div>
        <div className="flex items-center justify-end gap-2">
          {error && <span className="text-xs text-bad">{error}</span>}
          {saved && <span className="text-xs text-ok">Saved</span>}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              setError("");
              try {
                await api("/api/settings", { method: "POST", json: { modalTokenId: modalId, modalTokenSecret: modalSecret, claudeToken } });
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
                return;
              }
              setModalId("");
              setModalSecret("");
              setClaudeToken("");
              setSaved(true);
              onSaved();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
