import { nanoid } from "nanoid";
import {
  query,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { db, now } from "./db";
import { WORKSPACE_ROOT } from "./modal";
import { spawnInSandbox } from "./transport";
import { getSecret } from "./secrets";
import { ensureStarted, getWorkspace, touch } from "./workspaces";
import { applyLoadout, loadoutHash, loadoutMcpServers } from "./catalog";

export type Thread = {
  id: string;
  workspace_id: string;
  title: string;
  repo: string | null;
  session_id: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  status: "idle" | "starting" | "running" | "waiting" | "error";
  created_at: number;
  updated_at: number;
};

/** Events we add on top of the SDK's own message stream. */
export type CsEvent =
  | { type: "cs_user"; text: string; images?: number; priority?: string }
  | { type: "cs_permission"; requestId: string; toolName: string; toolUseID?: string; input: Record<string, unknown>; suggestions?: PermissionUpdate[]; title?: string; description?: string; blockedPath?: string }
  | { type: "cs_permission_resolved"; requestId: string; behavior: "allow" | "deny" }
  | { type: "cs_status"; status: Thread["status"]; detail?: string }
  | { type: "cs_log"; text: string };

export type StreamEvent = { seq?: number; at: number; event: SDKMessage | CsEvent };

export function listThreads(workspaceId: string): Thread[] {
  return db().prepare("SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as Thread[];
}

export function getThread(id: string): Thread {
  const t = db().prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
  if (!t) throw new Error(`Thread ${id} not found`);
  return t;
}

export function createThread(workspaceId: string, opts: { repo?: string | null; title?: string; forkOf?: string }) {
  const id = nanoid(10);
  const t = now();
  const parent = opts.forkOf ? getThread(opts.forkOf) : null;
  db()
    .prepare(
      "INSERT INTO threads (id, workspace_id, title, repo, session_id, model, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      workspaceId,
      opts.title ?? (parent ? `${parent.title} (fork)` : "New thread"),
      parent?.repo ?? opts.repo ?? null,
      null,
      parent?.model ?? null,
      parent?.permission_mode ?? "default",
      t,
      t,
    );
  if (parent?.session_id) forks.set(id, parent.session_id);
  return getThread(id);
}

export function deleteThread(id: string) {
  runners.get(id)?.close();
  db().prepare("DELETE FROM threads WHERE id = ?").run(id);
}

export function renameThread(id: string, title: string) {
  db().prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
}

export function threadEvents(id: string, afterSeq = 0): StreamEvent[] {
  const rows = db()
    .prepare("SELECT seq, json, created_at FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq")
    .all(id, afterSeq) as { seq: number; json: string; created_at: number }[];
  return rows.map((r) => ({ seq: r.seq, at: r.created_at, event: JSON.parse(r.json) }));
}

// ---- Runners -----------------------------------------------------------------

const g = globalThis as unknown as { __csRunners?: Map<string, Runner>; __csForks?: Map<string, string> };
const runners = (g.__csRunners ??= new Map());
const forks = (g.__csForks ??= new Map()); // threadId -> session id to fork from

export function runnerFor(threadId: string): Runner {
  let r = runners.get(threadId);
  if (!r) {
    r = new Runner(threadId);
    runners.set(threadId, r);
  }
  return r;
}

export function existingRunner(threadId: string) {
  return runners.get(threadId);
}

/** Async queue feeding user messages into the SDK's streaming input. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(m: SDKUserMessage) {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

type Pending = { resolve: (r: PermissionResult) => void; event: Extract<CsEvent, { type: "cs_permission" }> };

export class Runner {
  private q: Query | null = null;
  private inbox: Inbox | null = null;
  private starting: Promise<Query> | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(e: StreamEvent) => void>();
  private heartbeat: NodeJS.Timeout | null = null;
  private turnsInFlight = 0;

  constructor(readonly threadId: string) {}

  get thread() {
    return getThread(this.threadId);
  }

  subscribe(fn: (e: StreamEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pendingRequests() {
    return [...this.pending.values()].map((p) => p.event);
  }

  get alive() {
    return !!this.q;
  }

  private emit(event: SDKMessage | CsEvent, persist = true) {
    const at = now();
    let seq: number | undefined;
    if (persist) {
      const row = db().prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?").get(this.threadId) as {
        next: number;
      };
      seq = row.next;
      db().prepare("INSERT INTO events (thread_id, seq, json, created_at) VALUES (?, ?, ?, ?)").run(this.threadId, seq, JSON.stringify(event), at);
      db().prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, this.threadId);
    }
    for (const l of this.listeners) l({ seq, at, event });
  }

  private setStatus(status: Thread["status"], detail?: string) {
    db().prepare("UPDATE threads SET status = ? WHERE id = ?").run(status, this.threadId);
    this.emit({ type: "cs_status", status, detail }, status === "error");
    const workspaceId = this.thread.workspace_id;
    if (status === "running" || status === "waiting") {
      touch(workspaceId);
      this.heartbeat ??= setInterval(() => touch(workspaceId), 60_000);
    } else if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private async start(): Promise<Query> {
    const thread = this.thread;
    const ws = getWorkspace(thread.workspace_id);
    this.setStatus("starting", "waking workspace");
    const sb = await ensureStarted(ws.id);

    const loadout: string[] = JSON.parse(ws.loadout);
    const hash = loadoutHash(loadout);
    if (hash !== ws.loadout_applied_hash) {
      this.setStatus("starting", "applying loadout");
      await applyLoadout(sb, loadout, (text) => this.emit({ type: "cs_log", text }, false));
      db().prepare("UPDATE workspaces SET loadout_applied_hash = ? WHERE id = ?").run(hash, ws.id);
    }

    const token = getSecret("claude-oauth-token");
    if (!token) throw new Error("No Claude token. Run `claude setup-token` and paste it in Settings.");

    const forkFrom = forks.get(this.threadId);
    const inbox = new Inbox();
    this.inbox = inbox;
    const q = query({
      prompt: inbox,
      options: {
        cwd: thread.repo ? `${WORKSPACE_ROOT}/${thread.repo}` : WORKSPACE_ROOT,
        resume: thread.session_id ?? forkFrom ?? undefined,
        forkSession: !thread.session_id && !!forkFrom,
        model: thread.model ?? undefined,
        permissionMode: thread.permission_mode,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        mcpServers: loadoutMcpServers(loadout),
        pathToClaudeCodeExecutable: "claude",
        env: {},
        canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts),
        spawnClaudeCodeProcess: (o) => spawnInSandbox(sb, o, { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }),
      },
    });
    this.q = q;
    void this.consume(q);
    this.setStatus("idle");
    return q;
  }

  private async consume(q: Query) {
    try {
      for await (const msg of q) {
        if (msg.type === "stream_event") {
          this.emit(msg, false);
          continue;
        }
        if (msg.type === "system" && msg.subtype === "session_state_changed") {
          // Authoritative turn-over signal: counting sends against results drifts when a
          // steering message folds into the running turn, leaving the thread "running" and
          // the workspace heartbeat on forever.
          if (msg.state === "idle") {
            this.turnsInFlight = 0;
            if (this.pending.size === 0) this.setStatus("idle");
          } else if (msg.state === "running" && this.pending.size === 0 && this.thread.status !== "running") {
            this.setStatus("running");
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          db().prepare("UPDATE threads SET session_id = ?, model = COALESCE(model, ?) WHERE id = ?").run(msg.session_id, msg.model, this.threadId);
          forks.delete(this.threadId);
        }
        this.emit(msg);
        if (msg.type === "result") {
          this.turnsInFlight = Math.max(0, this.turnsInFlight - 1);
          if (this.turnsInFlight === 0 && this.pending.size === 0) this.setStatus("idle");
          this.autoTitle();
        }
      }
      this.setStatus("idle");
    } catch (err) {
      // Stopping a workspace terminates its sandbox and with it this Claude process;
      // that's expected, not an error. The next send resumes the session.
      const ws = getWorkspace(this.thread.workspace_id);
      if (ws.state === "snapshotting" || ws.state === "stopped") this.setStatus("idle");
      else this.setStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.q = null;
      this.inbox = null;
      this.turnsInFlight = 0;
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: "deny", message: "Session ended" });
        this.pending.delete(id);
      }
    }
  }

  private autoTitle() {
    const t = this.thread;
    if (t.title !== "New thread") return;
    const first = db()
      .prepare("SELECT json FROM events WHERE thread_id = ? AND json LIKE '%\"cs_user\"%' ORDER BY seq LIMIT 1")
      .get(this.threadId) as { json: string } | undefined;
    if (!first) return;
    const text = (JSON.parse(first.json) as { text: string }).text.replace(/\s+/g, " ").trim();
    renameThread(this.threadId, text.length > 60 ? text.slice(0, 57) + "…" : text || "New thread");
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID?: string; title?: string; description?: string; blockedPath?: string },
  ): Promise<PermissionResult> {
    const requestId = nanoid(8);
    const event: Pending["event"] = {
      type: "cs_permission",
      requestId,
      toolName,
      toolUseID: opts.toolUseID,
      input,
      suggestions: opts.suggestions,
      title: opts.title,
      description: opts.description,
      blockedPath: opts.blockedPath,
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, event });
      this.emit(event);
      this.setStatus("waiting");
      opts.signal.addEventListener("abort", () => this.respond(requestId, { behavior: "deny", message: "Cancelled" }), { once: true });
    });
  }

  respond(requestId: string, result: PermissionResult) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(result);
    this.emit({ type: "cs_permission_resolved", requestId, behavior: result.behavior });
    if (this.pending.size === 0) this.setStatus(this.turnsInFlight > 0 ? "running" : "idle");
    return true;
  }

  private async ensure(): Promise<Query> {
    if (this.q) return this.q;
    this.starting ??= this.start().finally(() => (this.starting = null));
    try {
      return await this.starting;
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async send(text: string, opts: { images?: { mediaType: string; data: string }[]; priority?: "now" | "next" | "later" } = {}) {
    this.emit({ type: "cs_user", text, images: opts.images?.length, priority: opts.priority });
    await this.ensure();
    const content: SDKUserMessage["message"]["content"] = [
      ...(opts.images ?? []).map((img) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data },
      })),
      { type: "text" as const, text },
    ];
    this.turnsInFlight++;
    this.setStatus("running");
    this.inbox!.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      priority: opts.priority,
      origin: { kind: "human" },
    });
  }

  async interrupt() {
    await this.q?.interrupt();
  }

  async setPermissionMode(mode: PermissionMode) {
    db().prepare("UPDATE threads SET permission_mode = ? WHERE id = ?").run(mode, this.threadId);
    await this.q?.setPermissionMode(mode);
  }

  async setModel(model: string | null) {
    db().prepare("UPDATE threads SET model = ? WHERE id = ?").run(model, this.threadId);
    await this.q?.setModel(model ?? undefined);
  }

  async stopTask(taskId: string) {
    await this.q?.stopTask(taskId);
  }

  async meta() {
    // Only a send should boot a stopped workspace; the composer asks for meta on every load.
    if (!this.q && getWorkspace(this.thread.workspace_id).state !== "started") return { commands: [], models: [], context: null };
    const q = await this.ensure();
    const [commands, models, context] = await Promise.all([
      q.supportedCommands().catch(() => []),
      q.supportedModels().catch(() => []),
      q.getContextUsage().catch(() => null),
    ]);
    return { commands, models, context };
  }

  close() {
    this.inbox?.close();
    this.q?.close();
    this.q = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    runners.delete(this.threadId);
  }
}
