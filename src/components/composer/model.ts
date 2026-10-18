// Turns the raw event stream (SDK messages + our cs_* events) into renderable items.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ev = { seq?: number; at: number; event: any };

export type PermissionEvent = {
  type: "cs_permission";
  requestId: string;
  toolName: string;
  toolUseID?: string;
  input: Record<string, any>;
  suggestions?: unknown[];
  title?: string;
  description?: string;
  blockedPath?: string;
};

export type Item =
  | { kind: "user"; key: string; text: string; images?: number; priority?: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; name: string; input: any; result?: any; isError?: boolean; children: Item[] }
  | { kind: "permission"; key: string; event: PermissionEvent; resolved?: "allow" | "deny" }
  | { kind: "result"; key: string; ev: any }
  | { kind: "divider"; key: string; text: string }
  | { kind: "notice"; key: string; text: string; tone: "muted" | "warn" | "bad" };

export type Task = { id: string; description: string; status: string; summary?: string; type?: string };

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export type View = {
  items: Item[];
  todos: Todo[] | null;
  tasks: Task[];
  rateLimit: any | null;
  init: any | null;
  lastResult: any | null;
};

export function buildView(events: Ev[]): View {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const permissions = new Map<string, Extract<Item, { kind: "permission" }>>();
  const tasks = new Map<string, Task>();
  let todos: Todo[] | null = null;
  let rateLimit: any = null;
  let init: any = null;
  let lastResult: any = null;

  const place = (item: Item, parent: string | null | undefined) => {
    const host = parent ? tools.get(parent) : undefined;
    (host ? host.children : items).push(item);
  };

  for (const { seq, event: e } of events) {
    const key = String(seq ?? Math.random());
    switch (e.type) {
      case "cs_user":
        items.push({ kind: "user", key, text: e.text, images: e.images, priority: e.priority });
        break;
      case "cs_permission": {
        const item = { kind: "permission" as const, key, event: e as PermissionEvent };
        permissions.set(e.requestId, item);
        items.push(item);
        break;
      }
      case "cs_permission_resolved": {
        const p = permissions.get(e.requestId);
        if (p) p.resolved = e.behavior;
        break;
      }
      case "cs_status":
        if (e.status === "error") items.push({ kind: "notice", key, text: e.detail ?? "Error", tone: "bad" });
        break;
      case "assistant": {
        const parent = e.parent_tool_use_id;
        for (const [i, block] of (e.message?.content ?? []).entries()) {
          const k = `${key}-${i}`;
          if (block.type === "text" && block.text?.trim()) place({ kind: "text", key: k, text: block.text }, parent);
          else if (block.type === "thinking" && block.thinking?.trim()) place({ kind: "thinking", key: k, text: block.thinking }, parent);
          else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            const tool = { kind: "tool" as const, key: k, id: block.id, name: block.name, input: block.input, children: [] };
            tools.set(block.id, tool);
            place(tool, parent);
            if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) todos = block.input.todos;
          }
        }
        if (e.error) items.push({ kind: "notice", key: `${key}-err`, text: `API error: ${e.error}`, tone: "bad" });
        break;
      }
      case "user": {
        const content = e.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_result") {
            const tool = tools.get(block.tool_use_id);
            if (tool) {
              tool.result = block.content;
              tool.isError = block.is_error;
            }
          }
        }
        break;
      }
      case "result":
        lastResult = e;
        items.push({ kind: "result", key, ev: e });
        break;
      case "system":
        if (e.subtype === "init") {
          init = e;
          items.push({ kind: "divider", key, text: `session · ${e.model} · ${e.permissionMode}` });
        } else if (e.subtype === "compact_boundary") {
          items.push({ kind: "divider", key, text: `context compacted (${e.compact_metadata?.trigger ?? "auto"})` });
        } else if (e.subtype === "api_retry") {
          items.push({ kind: "notice", key, text: `API retry ${e.attempt ?? ""}${e.error ? `: ${e.error}` : ""}`, tone: "warn" });
        } else if (e.subtype === "task_started") {
          tasks.set(e.task_id, { id: e.task_id, description: e.description ?? e.workflow_name ?? "task", status: "running", type: e.task_type });
        } else if (e.subtype === "task_progress" || e.subtype === "task_updated") {
          const t = tasks.get(e.task_id);
          if (t) {
            t.summary = e.summary ?? e.description ?? t.summary;
            if (e.patch?.status) t.status = e.patch.status;
          }
        } else if (e.subtype === "task_notification") {
          const t: Task = tasks.get(e.task_id) ?? { id: e.task_id, description: e.summary ?? "task", status: "" };
          t.status = e.status;
          t.summary = e.summary;
          tasks.set(e.task_id, t);
        } else if (e.subtype === "local_command_output" && e.content) {
          items.push({ kind: "text", key, text: "```\n" + e.content + "\n```" });
        } else if (e.subtype === "notification" && e.text) {
          items.push({ kind: "notice", key, text: e.text, tone: "muted" });
        }
        break;
      case "rate_limit_event":
        rateLimit = e.rate_limit_info ?? e;
        break;
      case "permission_denied":
        items.push({ kind: "notice", key, text: `Denied: ${e.tool_name ?? ""} ${e.message ?? ""}`, tone: "warn" });
        break;
    }
  }

  return { items, todos, tasks: [...tasks.values()], rateLimit, init, lastResult };
}

/** Accumulate token deltas from stream_event partials for the in-progress top-level message. */
export function applyPartial(live: { text: string; thinking: string }, e: any) {
  if (e.parent_tool_use_id) return live;
  const ev = e.event;
  if (ev?.type === "message_start") return { text: "", thinking: "" };
  if (ev?.type === "content_block_delta") {
    if (ev.delta?.type === "text_delta") return { ...live, text: live.text + ev.delta.text };
    if (ev.delta?.type === "thinking_delta") return { ...live, thinking: live.thinking + ev.delta.thinking };
  }
  return live;
}

export function resultText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
  return JSON.stringify(content, null, 2);
}
