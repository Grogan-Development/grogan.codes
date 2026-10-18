"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../ui";
import { resultText, type Item, type PermissionEvent } from "./model";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-cs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function ItemView({ item, onRespond }: { item: Item; onRespond: Responder }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-panel-3 border border-[#2a2d27] px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap">
            {item.text}
            {item.images ? <div className="text-xs text-muted mt-1">{item.images} image(s) attached</div> : null}
            {item.priority && item.priority !== "now" ? <div className="text-xs text-muted mt-1">queued</div> : null}
          </div>
        </div>
      );
    case "text":
      return <Markdown text={item.text} />;
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolCard item={item} onRespond={onRespond} />;
    case "permission":
      return <PermissionCard item={item} onRespond={onRespond} />;
    case "result":
      return <ResultFooter ev={item.ev} />;
    case "divider":
      return (
        <div className="flex items-center gap-3 text-[11px] text-muted uppercase tracking-wide">
          <div className="h-px flex-1 bg-line" />
          {item.text}
          <div className="h-px flex-1 bg-line" />
        </div>
      );
    case "notice":
      return (
        <div
          className={`text-xs rounded-md px-3 py-2 border ${
            item.tone === "bad" ? "border-bad/40 text-bad bg-bad/5" : item.tone === "warn" ? "border-warn/40 text-warn bg-warn/5" : "border-line text-muted"
          }`}
        >
          {item.text}
        </div>
      );
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-muted text-[13px]">
      <button onClick={() => setOpen(!open)} className="hover:text-text">
        {open ? "▾" : "▸"} thinking
      </button>
      {open && <div className="mt-1 pl-3 border-l border-line whitespace-pre-wrap italic">{text}</div>}
    </div>
  );
}

function short(s: string, n = 90) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function toolSummary(name: string, input: any): string {
  if (!input) return "";
  switch (name) {
    case "Bash":
      return input.command;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return input.file_path ?? input.notebook_path;
    case "Grep":
      return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
    case "Glob":
      return input.pattern;
    case "WebFetch":
      return input.url;
    case "WebSearch":
      return input.query;
    case "Task":
    case "Agent":
      return `${input.subagent_type ?? "agent"}: ${input.description ?? ""}`;
    case "TodoWrite":
      return `${input.todos?.length ?? 0} todos`;
    case "Skill":
      return input.skill ?? input.command;
    default:
      return Object.values(input).filter((v) => typeof v === "string").join(" · ");
  }
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <pre className="font-mono text-xs overflow-x-auto bg-bg rounded-md p-2 border border-line max-h-96">
      {oldStr.split("\n").map((l, i) => (
        <div key={`o${i}`} className="text-[#ffb3a3] bg-[rgba(255,107,74,.08)]">
          - {l}
        </div>
      ))}
      {newStr.split("\n").map((l, i) => (
        <div key={`n${i}`} className="text-[#b9eba3] bg-[rgba(139,216,106,.08)]">
          + {l}
        </div>
      ))}
    </pre>
  );
}

function ToolBody({ name, input }: { name: string; input: any }) {
  if (name === "Edit") return <DiffView oldStr={input.old_string ?? ""} newStr={input.new_string ?? ""} />;
  if (name === "MultiEdit")
    return (
      <div className="space-y-1">
        {(input.edits ?? []).map((e: any, i: number) => (
          <DiffView key={i} oldStr={e.old_string} newStr={e.new_string} />
        ))}
      </div>
    );
  if (name === "Write")
    return <pre className="font-mono text-xs overflow-auto bg-bg rounded-md p-2 border border-line max-h-80 text-ok">{input.content}</pre>;
  if (name === "Bash")
    return <pre className="font-mono text-xs whitespace-pre-wrap bg-bg rounded-md p-2 border border-line">$ {input.command}</pre>;
  if (name === "TodoWrite") return <TodoList todos={input.todos ?? []} />;
  return <pre className="font-mono text-xs overflow-auto bg-bg rounded-md p-2 border border-line max-h-60">{JSON.stringify(input, null, 2)}</pre>;
}

function ToolCard({ item, onRespond }: { item: Extract<Item, { kind: "tool" }>; onRespond: Responder }) {
  const isAgent = item.name === "Task" || item.name === "Agent";
  const [open, setOpen] = useState(isAgent || item.name === "Edit" || item.name === "MultiEdit" || item.name === "TodoWrite");
  const pending = item.result === undefined;
  const out = resultText(item.result);
  return (
    <div className={`rounded-[10px] border ${item.isError ? "border-bad/40" : pending ? "border-[#33402a]" : "border-line"} bg-[#121310] overflow-hidden`}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2.5 px-3 py-2 text-left">
        <span className={`size-1.5 rounded-full ${pending ? "bg-accent animate-pulse" : item.isError ? "bg-bad" : "bg-ok"}`} />
        <span className="font-semibold text-[13px]">{item.name.replace(/^mcp__/, "").replace(/__/g, " · ")}</span>
        <span className="text-muted text-xs font-mono truncate">{short(toolSummary(item.name, item.input) ?? "")}</span>
        <span className="ml-auto text-muted text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-line">
          {!isAgent && <ToolBody name={item.name} input={item.input} />}
          {isAgent && item.input?.prompt && <div className="text-xs text-muted whitespace-pre-wrap line-clamp-6">{item.input.prompt}</div>}
          {item.children.length > 0 && (
            <div className="pl-3 border-l-2 border-line space-y-2">
              {item.children.map((c) => (
                <ItemView key={c.key} item={c} onRespond={onRespond} />
              ))}
            </div>
          )}
          {!pending && out && item.name !== "TodoWrite" && (
            <pre
              className={`font-mono text-xs whitespace-pre-wrap overflow-auto max-h-72 rounded-md p-2 border ${
                item.isError ? "border-bad/40 text-bad" : "border-line text-muted"
              } bg-bg`}
            >
              {out.length > 20000 ? out.slice(0, 20000) + "\n… (truncated)" : out}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function TodoList({ todos }: { todos: { content: string; status: string; activeForm?: string }[] }) {
  return (
    <ul className="space-y-0.5 text-[13px]">
      {todos.map((t, i) => (
        <li key={i} className={`flex gap-2 ${t.status === "completed" ? "text-muted line-through" : ""}`}>
          <span>{t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"}</span>
          <span className={t.status === "in_progress" ? "text-accent" : ""}>{t.status === "in_progress" ? t.activeForm ?? t.content : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function ResultFooter({ ev }: { ev: any }) {
  const tokens = ev.usage ? (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) : 0;
  return (
    <div className={`text-[11px] ${ev.is_error ? "text-bad" : "text-muted"} flex flex-wrap gap-x-3`}>
      <span>{ev.subtype === "success" ? "done" : ev.subtype}</span>
      {ev.duration_ms != null && <span>{(ev.duration_ms / 1000).toFixed(1)}s</span>}
      {ev.num_turns != null && <span>{ev.num_turns} turns</span>}
      {tokens > 0 && <span>{(tokens / 1000).toFixed(1)}k tokens</span>}
      {ev.total_cost_usd != null && <span>${ev.total_cost_usd.toFixed(3)} equiv.</span>}
      {ev.terminal_reason && <span>{ev.terminal_reason}</span>}
      {ev.is_error && ev.result && <span>{ev.result}</span>}
    </div>
  );
}

// ---- Approvals ------------------------------------------------------------------

export type Responder = (requestId: string, result: any, then?: { permissionMode?: string }) => void;

function PermissionCard({ item, onRespond }: { item: Extract<Item, { kind: "permission" }>; onRespond: Responder }) {
  const e = item.event;
  if (item.resolved)
    return (
      <div className="text-xs text-muted">
        {e.toolName}: {item.resolved === "allow" ? "approved" : "denied"}
      </div>
    );
  if (e.toolName === "AskUserQuestion") return <AskQuestion e={e} onRespond={onRespond} />;
  if (e.toolName === "ExitPlanMode") return <PlanReview e={e} onRespond={onRespond} />;
  return <Approval e={e} onRespond={onRespond} />;
}

/** Everything that blocks Claude on the user shares the amber "needs you" treatment. */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-[#5a4a26] bg-[#1a170f] p-3.5 space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-warn text-xs font-bold text-bg">!</span>
        <span className="font-semibold">{title}</span>
      </div>
      {children}
    </section>
  );
}

function Approval({ e, onRespond }: { e: PermissionEvent; onRespond: Responder }) {
  const [reason, setReason] = useState("");
  return (
    <Shell title={e.title ?? `Allow ${e.toolName}?`}>
      {e.description && <p className="text-[13px]">{e.description}</p>}
      {e.blockedPath && <p className="text-xs text-muted">Outside allowed paths: {e.blockedPath}</p>}
      <ToolBody name={e.toolName} input={e.input} />
      <div className="flex flex-wrap gap-2 items-center">
        <Button variant="attn" onClick={() => onRespond(e.requestId, { behavior: "allow", updatedInput: e.input })}>
          Allow once
        </Button>
        {e.suggestions && e.suggestions.length > 0 && (
          <Button onClick={() => onRespond(e.requestId, { behavior: "allow", updatedInput: e.input, updatedPermissions: e.suggestions })}>
            Always allow
          </Button>
        )}
        <input
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          placeholder="Reason / what to do instead"
          aria-label="Reason for denying"
          className="h-8 flex-1 min-w-40 rounded-lg bg-bg border border-[#2f2a1c] px-2.5 outline-none placeholder:text-faint focus:border-warn"
        />
        <Button variant="ghost" onClick={() => onRespond(e.requestId, { behavior: "deny", message: reason || "User denied" })}>
          Deny
        </Button>
      </div>
    </Shell>
  );
}

function AskQuestion({ e, onRespond }: { e: PermissionEvent; onRespond: Responder }) {
  const questions: any[] = e.input.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: any, label: string) =>
    setAnswers((a) => {
      const cur = a[q.question] ?? [];
      return { ...a, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    });
  return (
    <Shell title="Claude has questions">
      {questions.map((q) => (
        <div key={q.question} className="space-y-1.5">
          <div className="font-medium">{q.question}</div>
          <div className="flex flex-col gap-1">
            {q.options?.map((o: any) => {
              const on = (answers[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, o.label)}
                  className={`text-left rounded-md border px-2.5 py-1.5 ${on ? "border-accent bg-accent/10" : "border-line hover:border-muted"}`}
                >
                  <div>{o.label}</div>
                  {o.description && <div className="text-xs text-muted">{o.description}</div>}
                </button>
              );
            })}
            <input
              placeholder="Other…"
              value={other[q.question] ?? ""}
              onChange={(ev) => setOther((o) => ({ ...o, [q.question]: ev.target.value }))}
              className="rounded-md bg-panel-2 border border-line px-2 py-1 outline-none focus:border-accent"
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          variant="attn"
          onClick={() => {
            const out: Record<string, string> = {};
            for (const q of questions) {
              const picked = [...(answers[q.question] ?? []), ...(other[q.question] ? [other[q.question]] : [])];
              out[q.question] = picked.join(", ");
            }
            onRespond(e.requestId, { behavior: "allow", updatedInput: { ...e.input, answers: out } });
          }}
        >
          Submit answers
        </Button>
        <Button variant="ghost" onClick={() => onRespond(e.requestId, { behavior: "deny", message: "User declined to answer" })}>
          Skip
        </Button>
      </div>
    </Shell>
  );
}

function PlanReview({ e, onRespond }: { e: PermissionEvent; onRespond: Responder }) {
  const [feedback, setFeedback] = useState("");
  return (
    <Shell title="Plan ready for review">
      <div className="max-h-[50vh] overflow-y-auto rounded-md bg-bg border border-line p-3">
        <Markdown text={e.input.plan ?? ""} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="attn" onClick={() => onRespond(e.requestId, { behavior: "allow", updatedInput: e.input }, { permissionMode: "acceptEdits" })}>
          Approve · auto-accept edits
        </Button>
        <Button onClick={() => onRespond(e.requestId, { behavior: "allow", updatedInput: e.input }, { permissionMode: "default" })}>
          Approve · ask for each edit
        </Button>
      </div>
      <div className="flex gap-2">
        <input
          value={feedback}
          onChange={(ev) => setFeedback(ev.target.value)}
          placeholder="Keep planning: what should change?"
          className="flex-1 rounded-md bg-panel-2 border border-line px-2 py-1 outline-none focus:border-accent"
        />
        <Button onClick={() => onRespond(e.requestId, { behavior: "deny", message: feedback || "Keep planning" })}>Keep planning</Button>
      </div>
    </Shell>
  );
}
