"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Thread } from "@/lib/api";
import { Button, Icon, Segmented } from "../ui";
import { ItemView, Markdown, TodoList, type Responder } from "./Blocks";
import { applyPartial, buildView, type Ev, type PermissionEvent } from "./model";

const MODES = [
  { value: "default", label: "Ask" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass" },
];

type Meta = {
  commands: { name: string; description: string; argumentHint: string }[];
  models: { value: string; displayName: string }[];
  context: { percentage: number; totalTokens: number; maxTokens: number } | null;
};

function useThread(threadId: string) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [live, setLive] = useState({ text: "", thinking: "" });
  const [status, setStatus] = useState<{ status: string; detail?: string }>({ status: "idle" });
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    setEvents([]);
    setLive({ text: "", thinking: "" });
    api<{ thread: Thread; events: Ev[]; pending: PermissionEvent[] }>(`/api/threads/${threadId}`).then((data) => {
      if (cancelled) return;
      setThread(data.thread);
      setStatus({ status: data.thread.status });
      setEvents(data.events);
      const last = data.events.at(-1)?.seq ?? 0;
      es = new EventSource(`/api/threads/${threadId}/stream?after=${last}`);
      es.onmessage = (m) => {
        const ev: Ev = JSON.parse(m.data);
        const e = ev.event;
        if (e.type === "stream_event") {
          setLive((l) => applyPartial(l, e));
          return;
        }
        if (e.type === "cs_status") {
          setStatus({ status: e.status, detail: e.detail });
          if (e.status !== "starting") setLogs([]);
        }
        if (e.type === "cs_log") {
          setLogs((l) => [...l.slice(-20), e.text]);
          return;
        }
        if (e.type === "assistant" && !e.parent_tool_use_id) setLive({ text: "", thinking: "" });
        if (ev.seq !== undefined) setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
      };
    });
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [threadId]);

  return { thread, setThread, events, live, status, logs };
}

export function Composer({ threadId, onThreadChanged }: { threadId: string; onThreadChanged: () => void }) {
  const { thread, setThread, events, live, status, logs } = useThread(threadId);
  const view = useMemo(() => buildView(events), [events]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ mediaType: string; data: string; name: string }[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [cmdIndex, setCmdIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busy = ["running", "waiting", "starting"].includes(status.status);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view, live]);

  const loadMeta = () => {
    if (!meta) api<Meta>(`/api/threads/${threadId}/meta`).then(setMeta).catch(() => {});
  };
  // Refresh context usage after each turn.
  useEffect(() => {
    if (view.lastResult) api<Meta>(`/api/threads/${threadId}/meta`).then(setMeta).catch(() => {});
  }, [view.lastResult, threadId]);

  const commandMatches = useMemo(() => {
    const m = text.match(/^\/(\S*)$/);
    if (!m || !meta) return [];
    return meta.commands.filter((c) => c.name.startsWith(m[1])).slice(0, 8);
  }, [text, meta]);

  const send = async (priority?: "now" | "next") => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setText("");
    setImages([]);
    stick.current = true;
    await api(`/api/threads/${threadId}/send`, {
      method: "POST",
      json: { text: t, images: images.map(({ mediaType, data }) => ({ mediaType, data })), priority: busy ? priority ?? "next" : undefined },
    });
    onThreadChanged();
  };

  const respond: Responder = async (requestId, result, then) => {
    await api(`/api/threads/${threadId}/respond`, { method: "POST", json: { requestId, result } });
    if (then?.permissionMode) {
      const t = await api<Thread>(`/api/threads/${threadId}`, { method: "PATCH", json: { permissionMode: then.permissionMode } });
      setThread(t);
    }
  };

  const patch = async (body: Record<string, unknown>) => setThread(await api<Thread>(`/api/threads/${threadId}`, { method: "PATCH", json: body }));

  const onPaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1];
        setImages((imgs) => [...imgs, { mediaType: file.type, data, name: file.name || "pasted image" }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const ctx = meta?.context;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-7 space-y-4">
          {view.items.length === 0 && !busy && (
            <div className="text-center text-muted py-16">
              <div className="text-base text-text mb-1">{thread?.repo ? `Working in ${thread.repo}` : "Working across the whole workspace"}</div>
            </div>
          )}
          {view.items.map((item) => (
            <ItemView key={item.key} item={item} onRespond={respond} />
          ))}
          {live.thinking && !live.text && <div className="text-muted italic text-[13px] line-clamp-3">{live.thinking.slice(-400)}</div>}
          {live.text && (
            <div className="opacity-90">
              <Markdown text={live.text} />
            </div>
          )}
          {status.status === "starting" && (
            <div className="text-xs text-muted space-y-0.5">
              <div className="animate-pulse">⏳ {status.detail ?? "starting Claude"}…</div>
              {logs.map((l, i) => (
                <div key={i} className="font-mono">
                  {l}
                </div>
              ))}
            </div>
          )}
          {status.status === "running" && !live.text && <div className="text-muted text-xs italic animate-pulse">Claude is working…</div>}
        </div>
      </div>

      {(view.todos || view.tasks.length > 0) && (
        <div className="px-4 sm:px-6">
          <div className="max-w-3xl mx-auto py-2 flex gap-6 text-xs">
            {view.todos && (
              <div className="flex-1 min-w-0 max-h-32 overflow-y-auto">
                <TodoList todos={view.todos} />
              </div>
            )}
            {view.tasks.length > 0 && (
              <div className="w-64 space-y-1 max-h-32 overflow-y-auto">
                <div className="label">Background tasks</div>
                {view.tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${t.status === "running" ? "bg-accent animate-pulse" : t.status === "completed" ? "bg-ok" : "bg-muted"}`} />
                    <span className="truncate flex-1" title={t.summary}>
                      {t.description}
                    </span>
                    {t.status === "running" && (
                      <button className="text-muted hover:text-bad" onClick={() => api(`/api/threads/${threadId}/control`, { method: "POST", json: { op: "stopTask", taskId: t.id } })}>
                        stop
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="px-4 pb-4 sm:px-6">
        <div className={`max-w-3xl mx-auto relative rounded-2xl border bg-panel-2 px-3 pt-3 pb-2.5 focus-within:border-faint ${busy ? "border-[#33402a]" : "border-line-2"}`}>
          {commandMatches.length > 0 && (
            <div className="absolute bottom-full mb-2 left-0 right-0 rounded-xl border border-line-2 bg-panel-3 shadow-xl overflow-hidden">
              {commandMatches.map((c, i) => (
                <button
                  key={c.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setText(`/${c.name} `);
                  }}
                  className={`w-full text-left px-3 py-1.5 flex gap-3 ${i === cmdIndex ? "bg-accent/15" : ""}`}
                >
                  <span className="font-mono">/{c.name}</span>
                  <span className="text-muted truncate">{c.description}</span>
                </button>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="flex gap-2 mb-2">
              {images.map((img, i) => (
                <span key={i} className="text-xs bg-panel-2 border border-line rounded px-2 py-0.5">
                  📎 {img.name}{" "}
                  <button className="text-muted" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={text}
            onFocus={loadMeta}
            onPaste={onPaste}
            onChange={(e) => {
              setText(e.target.value);
              setCmdIndex(0);
              if (e.target.value.startsWith("/")) loadMeta();
            }}
            onKeyDown={(e) => {
              if (commandMatches.length) {
                if (e.key === "ArrowDown") return e.preventDefault(), setCmdIndex((i) => (i + 1) % commandMatches.length);
                if (e.key === "ArrowUp") return e.preventDefault(), setCmdIndex((i) => (i - 1 + commandMatches.length) % commandMatches.length);
                if (e.key === "Tab") return e.preventDefault(), setText(`/${commandMatches[cmdIndex].name} `);
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(e.metaKey || e.ctrlKey ? "now" : "next");
              }
              if (e.key === "Escape" && busy) void api(`/api/threads/${threadId}/control`, { method: "POST", json: { op: "interrupt" } });
            }}
            rows={Math.min(10, Math.max(2, text.split("\n").length))}
            placeholder={busy ? "Queue a follow-up (Enter) or steer now (⌘Enter)…" : "Message Claude…"}
            aria-label="Message Claude"
            className="w-full resize-none bg-transparent px-1 py-0.5 leading-relaxed outline-none placeholder:text-faint"
          />
          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
            <Segmented
              label="Permission mode"
              value={thread?.permission_mode ?? "default"}
              onChange={(v) => patch({ permissionMode: v })}
              options={MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
            <select
              value={thread?.model ?? ""}
              onFocus={loadMeta}
              onChange={(e) => patch({ model: e.target.value || null })}
              className="h-7 rounded-md border border-transparent bg-transparent px-1.5 text-muted hover:border-line-2 hover:text-text max-w-44"
              title="Model"
            >
              <option value="">{thread?.model ?? "Default model"}</option>
              {meta?.models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {ctx && (
              <span className="text-muted" title={`${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens`}>
                context {Math.round(ctx.percentage)}%
              </span>
            )}
            {view.rateLimit?.utilization != null && <span className="text-muted">usage {Math.round(view.rateLimit.utilization * 100)}%</span>}
            <span className="text-muted ml-auto">{status.status === "error" ? <span className="text-bad">{status.detail}</span> : status.status}</span>
            {busy && (
              <Button
                variant="danger"
                size="icon"
                aria-label="Stop Claude"
                title="Stop Claude (Esc)"
                onClick={() => api(`/api/threads/${threadId}/control`, { method: "POST", json: { op: "interrupt" } })}
              >
                <Icon name="square" size={12} />
              </Button>
            )}
            {busy ? (
              <>
                <Button onClick={() => send("next")} disabled={!text.trim() && images.length === 0} title="Queue for after this turn (Enter)">
                  Queue
                </Button>
                <Button variant="primary" onClick={() => send("now")} disabled={!text.trim() && images.length === 0} title="Steer the running turn (⌘Enter)">
                  Steer now
                </Button>
              </>
            ) : (
              <Button variant="primary" size="icon" aria-label="Send" onClick={() => send("next")} disabled={!text.trim() && images.length === 0}>
                <Icon name="send" size={15} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
