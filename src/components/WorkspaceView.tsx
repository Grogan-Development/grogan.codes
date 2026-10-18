"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, machineLabel, RESTORE_HINT, type RepoRisk, type Thread, type Workspace } from "@/lib/api";
import { Button, ColdTag, Icon, Input, Logo, MarketTag, Spinner, StateDot } from "./ui";
import { Composer } from "./composer/Composer";
import { LoadoutPicker } from "./LoadoutPicker";
import { DeleteWorkspace } from "./DeleteFlow";

type Full = Workspace & { threads: Thread[] };
type Panel = "diff" | "terminal" | "browser" | "ports" | "loadout";

const PANELS: { id: Panel; label: string; icon: "diff" | "terminal" | "browser" | "ports" | "loadout" }[] = [
  { id: "diff", label: "Diff", icon: "diff" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "browser", label: "Browser", icon: "browser" },
  { id: "ports", label: "Ports", icon: "ports" },
  { id: "loadout", label: "Loadout", icon: "loadout" },
];

/** Per-viewer dock layout; storage can be unavailable (private windows), so every access is guarded. */
function useStored<T>(key: string, initial: T, fallback?: () => T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {}
    if (raw !== null) setValue(JSON.parse(raw));
    else if (fallback) setValue(fallback());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {}
  };
  return [value, set];
}

export function WorkspaceView({ id }: { id: string }) {
  const router = useRouter();
  const [ws, setWs] = useState<Full | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [panel, setPanel] = useStored<Panel>("cs.dock.panel", "diff");
  // Below 1280px the dock overlays the conversation, so it starts collapsed there.
  const [dockOpen, setDockOpen] = useStored("cs.dock.open", false, () => window.innerWidth >= 1280);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api<Full>(`/api/workspaces/${id}`)
      .then((w) => {
        setWs(w);
        const wanted = new URLSearchParams(window.location.search).get("thread");
        setActive((a) => a ?? (wanted && w.threads.some((t) => t.id === wanted) ? wanted : (w.threads[0]?.id ?? null)));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const newThread = async (repo: string | null, forkOf?: string) => {
    const t = await api<Thread>(`/api/workspaces/${id}/threads`, { method: "POST", json: { repo, forkOf } });
    setActive(t.id);
    load();
  };

  const act = async (action: "start" | "pause" | "stop" | "setup" | "archive") => {
    // A 409 means another action is already running; other failures land on the row's error.
    await api(`/api/workspaces/${id}/action`, { method: "POST", json: { action } }).catch(() => {});
    load();
  };

  if (!ws) return <div className="p-8 text-muted">{error || "Loading…"}</div>;
  const live = ws.state === "started";
  // A stopped workspace still shows its threads; sending a message starts its instance again.
  const usable = live || ws.state === "stopped" || ws.state === "error";
  // Rows from the Modal era have no instance to start; they can only be deleted.
  const startable = !!ws.instance_type && ["stopped", "error"].includes(ws.state);
  const working = ws.threads.some((t) => ["running", "starting", "waiting"].includes(t.status));
  const activeThread = ws.threads.find((t) => t.id === active);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <Logo />
        <span className="flex min-w-0 items-center gap-2 px-1 text-sm font-semibold">
          <span className="truncate">{ws.name}</span>
        </span>
        {ws.error && (
          <span className="max-w-md truncate text-xs text-bad" title={ws.error}>
            {ws.error}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex h-8 items-center gap-2.5 rounded-full border border-line bg-panel-2 px-3 text-xs">
            <StateDot state={ws.state} />
            <span className="font-semibold capitalize">{ws.state}</span>
            <span className={`font-mono ${ws.machine?.gpu ? "text-gpu" : "text-muted"}`}>{machineLabel(ws)}</span>
            {ws.archived && <ColdTag archivedAt={ws.archived_at} />}
            {ws.market && <MarketTag market={ws.market} />}
            {ws.region && (
              <span className="font-mono text-faint" title={ws.az ? `Availability zone ${ws.az}` : undefined}>
                {ws.region}
              </span>
            )}
            {live && (
              <>
                <span className="h-3.5 w-px bg-line-2" />
                <span className="text-muted">{working ? "busy · won’t stop" : `stops after ${ws.idle_minutes}m idle`}</span>
              </>
            )}
          </div>
          {live && ws.hibernate ? (
            <>
              <Button onClick={() => act("pause")} title="Hibernate: saves memory to disk and stops the instance. Running processes and files come back on start.">
                <Icon name="stop" />
                Hibernate <span className="text-muted">keeps memory</span>
              </Button>
              <Button variant="ghost" onClick={() => act("stop")} title="Stop the instance. Files are kept; running processes end.">
                Stop
              </Button>
            </>
          ) : live ? (
            <Button onClick={() => act("stop")} title="Stop the instance. Files are kept; running processes end.">
              <Icon name="stop" />
              Stop
            </Button>
          ) : ws.state === "setup failed" ? (
            <Button variant="primary" onClick={() => act("setup")}>
              Retry setup
            </Button>
          ) : startable ? (
            <>
              {ws.state === "stopped" && !ws.archived && ws.instance_id && (
                <Button
                  variant="ghost"
                  onClick={() => act("archive")}
                  title="Snapshot the disk and remove the instance now. A stopped disk costs about $0.08/GB-month; a snapshot about $0.05/GB-month of data actually written. The next start takes a few extra minutes."
                >
                  Archive now
                </Button>
              )}
              <Button variant="primary" onClick={() => act("start")} title={ws.archived ? RESTORE_HINT : undefined}>
                <Icon name="play" size={12} />
                Start
              </Button>
            </>
          ) : null}
          <Button variant="ghost" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <nav aria-label="Threads and repos" className="hidden h-full min-h-0 w-[260px] shrink-0 flex-col border-r border-line bg-panel md:flex">
          <Threads ws={ws} active={active} setActive={setActive} newThread={newThread} reload={load} />
          <Repos ws={ws} reload={load} />
          <IdleSetting ws={ws} reload={load} />
        </nav>

        <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          {activeThread && (
            <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-6">
              <span className="truncate font-semibold">{activeThread.title}</span>
              <span className="rounded-[5px] border border-line-2 px-1.5 py-px font-mono text-xs text-muted">{activeThread.repo ?? "workspace"}</span>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!usable ? (
              <div className="flex h-full items-center justify-center text-muted">
                <div className="space-y-2 text-center">
                  <div className="animate-pulse capitalize">{ws.state}…</div>
                </div>
              </div>
            ) : active ? (
              <Composer key={active} threadId={active} onThreadChanged={load} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
                <p>No threads yet.</p>
                <Button variant="primary" onClick={() => newThread(null)}>
                  <Icon name="plus" />
                  Start a thread
                </Button>
              </div>
            )}
          </div>
        </main>

        {dockOpen ? (
          <aside
            aria-label="Machine"
            className="absolute inset-y-0 right-0 z-20 flex h-full min-h-0 w-[min(480px,100%)] flex-col border-l border-line bg-panel shadow-2xl xl:static xl:w-[440px] xl:shrink-0 xl:shadow-none 2xl:w-[520px]"
          >
            <div role="tablist" className="flex h-11 shrink-0 items-center border-b border-line pr-1 pl-2">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                {PANELS.map((p) => (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={panel === p.id}
                    onClick={() => setPanel(p.id)}
                    className={`inline-flex h-11 items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium whitespace-nowrap ${
                      panel === p.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Button variant="ghost" size="icon" aria-label="Collapse panel" title="Collapse panel" onClick={() => setDockOpen(false)}>
                <Icon name="collapse" size={16} />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <SidePanel ws={ws} panel={panel} reload={load} onStart={() => act("start")} />
            </div>
          </aside>
        ) : (
          <aside aria-label="Machine panels" className="flex h-full shrink-0 basis-14 flex-col items-center gap-1 border-l border-line bg-panel pt-2">
            {PANELS.map((p) => (
              <button
                key={p.id}
                aria-label={p.label}
                title={p.label}
                onClick={() => (setPanel(p.id), setDockOpen(true))}
                className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-panel-3 hover:text-text"
              >
                <Icon name={p.icon} size={18} />
              </button>
            ))}
          </aside>
        )}
      </div>

      {deleting && <DeleteWorkspace id={id} name={ws.name} archived={ws.archived} onClose={() => setDeleting(false)} onDone={() => router.push("/")} />}
    </div>
  );
}

function Threads({
  ws,
  active,
  setActive,
  newThread,
  reload,
}: {
  ws: Full;
  active: string | null;
  setActive: (id: string) => void;
  newThread: (repo: string | null, forkOf?: string) => void;
  reload: () => void;
}) {
  const [scope, setScope] = useState("");
  const needs = ws.threads.filter((t) => t.status === "waiting");
  const working = ws.threads.filter((t) => t.status === "running" || t.status === "starting");
  const earlier = ws.threads.filter((t) => !needs.includes(t) && !working.includes(t));

  const group = (label: string, threads: Thread[], tone = "") =>
    threads.length > 0 && (
      <>
        <div className={`label px-2.5 pt-3.5 pb-1.5 ${tone}`}>
          {label} · {threads.length}
        </div>
        {threads.map((t) => (
          <ThreadRow key={t.id} t={t} on={active === t.id} onPick={() => setActive(t.id)} newThread={newThread} reload={reload} />
        ))}
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2 px-3 pt-3.5 pb-2">
        <Button variant="primary" className="flex-1 justify-center" onClick={() => newThread(scope || null)}>
          <Icon name="plus" />
          New thread
        </Button>
        <select
          aria-label="New thread scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="h-8 max-w-28 rounded-lg border border-line-2 bg-panel-3 px-1.5 text-xs"
        >
          <option value="">workspace</option>
          {ws.repos.map((r) => (
            <option key={r.id} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {group("Needs you", needs, "text-warn")}
        {group("Working", working)}
        {group(needs.length || working.length ? "Earlier" : "Threads", earlier)}
      </div>
    </div>
  );
}

function ThreadRow({
  t,
  on,
  onPick,
  newThread,
  reload,
}: {
  t: Thread;
  on: boolean;
  onPick: () => void;
  newThread: (repo: string | null, forkOf?: string) => void;
  reload: () => void;
}) {
  const waiting = t.status === "waiting";
  const busy = t.status === "running" || t.status === "starting";
  return (
    <div className={`group flex items-center rounded-lg ${on ? "bg-panel-3" : "hover:bg-panel-3"} ${on && waiting ? "shadow-[inset_0_0_0_1px_#3a3324]" : ""}`}>
      <button onClick={onPick} aria-current={on} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
        {waiting ? (
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-md bg-warn text-[11px] font-bold text-bg">!</span>
        ) : busy ? (
          <Spinner size={18} />
        ) : (
          <span className="flex w-[18px] shrink-0 justify-center">
            <span className={`size-[7px] rounded-full ${t.status === "error" ? "bg-bad" : "bg-[#4a4e44]"}`} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${waiting || busy ? "font-semibold" : "text-text-2"}`}>{t.title}</span>
        </span>
      </button>
      <span className="hidden shrink-0 gap-2 pr-2 text-[11px] text-muted group-hover:flex group-focus-within:flex">
        {t.session_id && (
          <button className="hover:text-text" onClick={() => newThread(null, t.id)}>
            fork
          </button>
        )}
        <button
          className="hover:text-bad"
          onClick={async () => {
            if (!confirm(`Delete thread "${t.title}"? Files in the workspace are not affected.`)) return;
            await api(`/api/threads/${t.id}`, { method: "DELETE" });
            reload();
          }}
        >
          delete
        </button>
      </span>
    </div>
  );
}

function Repos({ ws, reload }: { ws: Full; reload: () => void }) {
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState("");
  const remove = async (repoId: string, name: string, force = false) => {
    try {
      await api(`/api/workspaces/${ws.id}/repos?repoId=${repoId}${force ? "&force=1" : ""}`, { method: "DELETE" });
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === "unsaved") {
        const r = (e.body.risks as RepoRisk[])[0];
        if (confirm(`${name} has ${r.dirty.length} uncommitted change(s) and ${r.unpushed.length} unpushed commit(s). Remove anyway and lose them?`))
          remove(repoId, name, true);
      } else setErr(String(e));
    }
  };
  return (
    <div className="border-t border-line px-2 pt-3 pb-2">
      <div className="label px-2.5 pb-2">Repos</div>
      {ws.repos.map((r) => (
        <div key={r.id} className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-panel-3">
          {r.state === "ready" ? <Icon name="branch" className="shrink-0 text-muted" /> : <StateDot state={r.state} />}
          <span className="min-w-0 flex-1 truncate" title={r.error ?? r.url}>
            <span className="font-mono text-[13px]">{r.name}</span>
            {r.branch && <span className="font-mono text-xs text-faint"> {r.branch}</span>}
            {r.error && <span className="text-xs text-bad"> {r.error}</span>}
          </span>
          <button aria-label={`Remove ${r.name}`} className="hidden text-muted group-hover:inline hover:text-bad" onClick={() => remove(r.id, r.name)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      <form
        className="px-1 pt-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!adding.trim()) return;
          setErr("");
          try {
            await api(`/api/workspaces/${ws.id}/repos`, { method: "POST", json: { repo: adding } });
            setAdding("");
            reload();
          } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
          }
        }}
      >
        <Input aria-label="Add repo" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="+ owner/repo" className="w-full py-1 font-mono text-xs" />
      </form>
      {err && <p className="px-2 pt-1 text-xs text-bad">{err}</p>}
    </div>
  );
}

function IdleSetting({ ws, reload }: { ws: Full; reload: () => void }) {
  return (
    <label className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-muted" title="Stop the instance after this long without activity. Files are kept.">
      Stop after
      <select
        value={ws.idle_minutes}
        onChange={async (e) => {
          await api(`/api/workspaces/${ws.id}`, { method: "PATCH", json: { idleMinutes: Number(e.target.value) } });
          reload();
        }}
        className="rounded-md border border-line-2 bg-panel-3 px-1 py-0.5 text-text"
      >
        {[10, 15, 30, 60, 120, 240].map((m) => (
          <option key={m} value={m}>
            {m}m
          </option>
        ))}
      </select>
      idle
    </label>
  );
}

/** Shown in place of a panel that needs a running instance, so opening the dock never starts one. */
function NeedsRunning({ ws, onStart }: { ws: Full; onStart: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-[15px] font-semibold">Workspace is {ws.archived ? "in cold storage" : ws.state}</div>
      {ws.instance_type && ["stopped", "error"].includes(ws.state) && (
        <Button variant="primary" onClick={onStart}>
          <Icon name="play" size={12} />
          Start
        </Button>
      )}
      {ws.archived && <p className="max-w-xs text-xs text-muted">{RESTORE_HINT}</p>}
    </div>
  );
}

function SidePanel({ ws, panel, reload, onStart }: { ws: Full; panel: Panel; reload: () => void; onStart: () => void }) {
  const live = ws.state === "started";
  // Port forwards are rebuilt after a restart, so panels remount when the instance starts again.
  const boot = `${ws.instance_id}:${ws.instance_started_at ?? ""}`;
  if (panel === "loadout") return <LoadoutPanel ws={ws} reload={reload} />;
  if (!live) return <NeedsRunning ws={ws} onStart={onStart} />;
  if (panel === "diff") return <DiffPanel key={boot} id={ws.id} />;
  if (panel === "terminal")
    return <FramePanel key={boot} header={<span>Terminal (ttyd)</span>} load={() => api<{ url: string }>(`/api/workspaces/${ws.id}/terminal`).then((r) => r.url)} />;
  if (panel === "browser") return <BrowserPanel key={boot} id={ws.id} />;
  return <PortsPanel id={ws.id} />;
}

function FramePanel({ load, header }: { load: () => Promise<string>; header?: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    load()
      .then(setUrl)
      .catch((e) => setErr(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-xs text-muted">
        {header}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="ml-auto text-muted hover:text-text">
            open in tab ↗
          </a>
        )}
      </div>
      {err ? (
        <p className="p-4 text-bad">{err}</p>
      ) : url ? (
        <iframe src={url} title="Panel" className="w-full flex-1 bg-black" allow="clipboard-read; clipboard-write" />
      ) : (
        <p className="p-4 text-muted">Connecting…</p>
      )}
    </div>
  );
}

function BrowserPanel({ id }: { id: string }) {
  return (
    <FramePanel
      header={
        <>
          <span>Desktop (Chromium, VNC)</span>
          <button className="hover:text-bad" onClick={() => api(`/api/workspaces/${id}/desktop`, { method: "DELETE" })}>
            stop desktop
          </button>
        </>
      }
      load={async () => `/desktop/${id}`}
    />
  );
}

function DiffPanel({ id }: { id: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    setDiff(null);
    setErr("");
    api<{ diff: string }>(`/api/workspaces/${id}/diff`)
      .then((r) => setDiff(r.diff))
      .catch((e) => setErr(String(e.message ?? e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);
  const files = (diff ?? "").split("\n").filter((l) => l.startsWith("diff --git") || l.startsWith("??")).length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-xs text-muted">
        <span>Uncommitted changes across repos</span>
        {files > 0 && <span className="rounded-full bg-[#2a2d27] px-1.5 py-px text-[11px] font-semibold text-text">{files}</span>}
        <Button size="sm" className="ml-auto" onClick={load}>
          Refresh
        </Button>
      </div>
      <pre className="flex-1 overflow-auto py-2 font-mono text-xs leading-relaxed">
        {err ? (
          <span className="block px-3.5 text-bad">{err}</span>
        ) : diff === null ? (
          <span className="block px-3.5 text-muted">Loading…</span>
        ) : diff.trim() === "" ? (
          <span className="block px-3.5 text-muted">Working trees are clean.</span>
        ) : (
          diff.split("\n").map((l, i) => (
            <div
              key={i}
              className={`px-3.5 ${
                l.startsWith("+") && !l.startsWith("+++")
                  ? "bg-[rgba(139,216,106,.08)] text-[#b9eba3]"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "bg-[rgba(255,107,74,.08)] text-[#ffb3a3]"
                    : l.startsWith("@@")
                      ? "text-faint"
                      : l.startsWith("diff ") || l.startsWith("??")
                        ? "mt-2 font-semibold text-text"
                        : "text-muted"
              }`}
            >
              {l || " "}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}

function LoadoutPanel({ ws, reload }: { ws: Full; reload: () => void }) {
  const [value, setValue] = useState<string[]>(JSON.parse(ws.loadout));
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-3 overflow-y-auto p-4">
      <LoadoutPicker value={value} onChange={(v) => (setValue(v), setSaved(false))} />
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={async () => {
            await api(`/api/workspaces/${ws.id}`, { method: "PATCH", json: { loadout: value } });
            setSaved(true);
            reload();
          }}
        >
          Save loadout
        </Button>
        {saved && <span className="text-xs text-ok">Saved</span>}
      </div>
    </div>
  );
}

function PortsPanel({ id }: { id: string }) {
  const [port, setPort] = useState("3000");
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  return (
    <div className="flex h-full flex-col">
      <form
        className="flex items-center gap-2 border-b border-line px-3.5 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          try {
            setUrl((await api<{ url: string }>(`/api/workspaces/${id}/preview?port=${port}`)).url);
          } catch (e) {
            setErr(String(e));
          }
        }}
      >
        <label className="text-xs text-muted" htmlFor="port">
          Port
        </label>
        <Input id="port" value={port} onChange={(e) => setPort(e.target.value)} className="w-24 py-1 font-mono text-xs" />
        <Button type="submit" size="sm">
          Preview
        </Button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="ml-auto text-xs text-muted hover:text-text">
            open in tab ↗
          </a>
        )}
      </form>
      {err && <p className="p-3 text-xs text-bad">{err}</p>}
      {url && <iframe src={url} title="Port preview" className="w-full flex-1 bg-white" />}
    </div>
  );
}
