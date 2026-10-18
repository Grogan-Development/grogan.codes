"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, timeAgo } from "@/lib/api";
import { FOCUS } from "./ui";

export type GhRepo = {
  fullName: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  language: string | null;
};

/** A repo to clone: what the user picked or pasted, and optionally a branch other than the default. */
export type RepoChoice = { spec: string; defaultBranch?: string; branch?: string };

/** The POST form: `owner/repo`, a URL, or `owner/repo#branch` when a non-default branch is picked. */
export const repoSpec = (c: RepoChoice) => (c.branch && c.branch !== c.defaultBranch ? `${c.spec}#${c.branch}` : c.spec);

/** "owner/name" for GitHub specs (short form or github.com URL), else null. */
function githubName(spec: string): string | null {
  const s = spec.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = s.match(/^([\w.-]+)\/([\w.-]+)$/) ?? s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function Badge({ children, tone = "" }: { children: string; tone?: string }) {
  return <span className={`rounded border border-line-2 px-1 text-[10px] ${tone || "text-muted"}`}>{children}</span>;
}

/**
 * Type to search your GitHub repos (debounced), pick with ↑↓ and Enter, or paste a URL or
 * owner/repo and press Enter. Falls back to plain input when gh isn't signed in.
 */
export function RepoCombobox({
  exclude = [],
  onPick,
  placeholder = "Search your repos, or paste owner/repo or a URL",
  className = "",
  onBackspaceEmpty,
  dropUp,
}: {
  exclude?: string[];
  onPick: (c: RepoChoice) => void;
  placeholder?: string;
  className?: string;
  onBackspaceEmpty?: () => void;
  /** Open the list above the input, for inputs near the bottom of the screen. */
  dropUp?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<GhRepo[]>([]);
  const [active, setActive] = useState(-1);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const seq = useRef(0);
  // The unfiltered list, so typing filters instantly while GitHub search adds the rest.
  const all = useRef<GhRepo[] | null>(null);

  // Debounced search; a later keystroke's answer always wins over an earlier one.
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const q = text.trim().toLowerCase();
    if (all.current) {
      setResults(q ? all.current.filter((r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)) : all.current);
      setActive(q ? 0 : -1); // Enter takes the top match while typing

    }
    const t = setTimeout(
      () => {
        setLoading(true);
        api<GhRepo[]>(`/api/github/repos?q=${encodeURIComponent(text.trim())}`)
          .then((r) => {
            if (!q) all.current = r;
            if (n !== seq.current) return;
            setResults(r);
            setActive((a) => (q && a < 0 ? 0 : a));
            setNote("");
          })
          .catch((e) => {
            if (n !== seq.current) return;
            setResults([]);
            setNote(e instanceof ApiError && e.status === 401 ? "GitHub: run gh auth login on this Mac. Pasting a URL still works." : `GitHub: ${e.message ?? e}`);
          })
          .finally(() => n === seq.current && setLoading(false));
      },
      text ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [text, open]);

  const shown = results.filter((r) => !exclude.includes(r.fullName));

  const pick = (c: RepoChoice) => {
    onPick(c);
    setText("");
    setActive(-1);
    setOpen(false);
  };
  const pickRaw = () => {
    const raw = text.trim().replace(/,$/, "");
    if (!raw) return;
    const match = results.find((r) => r.fullName.toLowerCase() === githubName(raw)?.toLowerCase());
    if (match) return pick({ spec: match.fullName, defaultBranch: match.defaultBranch });
    // Only something shaped like a repo becomes a chip; a search word picks the top match.
    if (githubName(raw) || /^(https?:\/\/|git@)/.test(raw)) return pick({ spec: raw });
    if (shown[0]) return pick({ spec: shown[0].fullName, defaultBranch: shown[0].defaultBranch });
    setNote(`No repo matches "${raw}". Paste owner/repo or a URL.`);
  };

  return (
    <div className={`relative min-w-40 flex-1 ${className}`}>
      <input
        role="combobox"
        aria-expanded={open && shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Leaving with a pasted repo still counts, so Create doesn't drop it.
          if (githubName(text) || /^(https?:\/\/|git@)/.test(text.trim())) pickRaw();
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && shown.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(shown.length - 1, a + 1));
          } else if (e.key === "ArrowUp" && shown.length) {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === ",") {
            if (e.key === "Enter" && !text.trim() && active < 0) return;
            e.preventDefault();
            if (active >= 0 && shown[active]) pick({ spec: shown[active].fullName, defaultBranch: shown[active].defaultBranch });
            else pickRaw();
          } else if (e.key === "Escape" && open) {
            // Close the list, not the surrounding modal.
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Backspace" && !text) onBackspaceEmpty?.();
        }}
        className="h-7 w-full bg-transparent font-mono text-xs outline-none placeholder:text-faint"
      />
      {open && (shown.length > 0 || note || loading) && (
        <div className={`absolute right-0 left-0 z-30 overflow-hidden ${dropUp ? "bottom-full mb-2" : "top-full mt-2"} rounded-[10px] border border-line-2 bg-panel shadow-2xl`}>
          {note && <p className="px-3 py-2 text-xs text-muted">{note}</p>}
          {!note && loading && !shown.length && <p className="px-3 py-2 text-xs text-muted">Searching GitHub…</p>}
          {shown.length > 0 && (
            <ul id={listId} role="listbox" aria-label="GitHub repos" className="max-h-64 overflow-y-auto py-1">
              {shown.map((r, i) => (
                <li
                  key={r.fullName}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick({ spec: r.fullName, defaultBranch: r.defaultBranch })}
                  className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 ${i === active ? "bg-panel-3" : ""}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-xs text-text">{r.fullName}</span>
                    {r.private && <Badge>private</Badge>}
                    {r.fork && <Badge>fork</Badge>}
                    {r.archived && <Badge tone="text-warn">archived</Badge>}
                  </span>
                  <span className="flex gap-2 text-[11px] text-faint">
                    {r.language && <span className="shrink-0">{r.language}</span>}
                    {r.pushedAt && <span className="shrink-0">pushed {timeAgo(Date.parse(r.pushedAt))}</span>}
                    {r.description && <span className="min-w-0 truncate">{r.description}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Chips for the picked repos, each with a branch selector, plus the combobox to add more. */
export function RepoChips({ value, onChange }: { value: RepoChoice[]; onChange: (v: RepoChoice[]) => void }) {
  const update = (spec: string, patch: Partial<RepoChoice>) => onChange(value.map((c) => (c.spec === spec ? { ...c, ...patch } : c)));
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line-2 bg-panel-2 p-2 focus-within:border-accent">
      {value.map((c) => (
        <RepoChip key={c.spec} c={c} onBranch={(branch, defaultBranch) => update(c.spec, { branch, defaultBranch })} onRemove={() => onChange(value.filter((x) => x.spec !== c.spec))} />
      ))}
      <RepoCombobox
        exclude={value.map((c) => githubName(c.spec) ?? c.spec)}
        placeholder={value.length ? "Add another" : "Search your repos, or paste owner/repo or a URL"}
        onPick={(c) => !value.some((x) => x.spec === c.spec) && onChange([...value, c])}
        onBackspaceEmpty={() => value.length && onChange(value.slice(0, -1))}
      />
    </div>
  );
}

function RepoChip({ c, onBranch, onRemove }: { c: RepoChoice; onBranch: (branch: string, defaultBranch: string) => void; onRemove: () => void }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const name = githubName(c.spec);
  const load = () => {
    if (!name || branches) return;
    api<string[]>(`/api/github/branches?repo=${encodeURIComponent(name)}`)
      .then(setBranches)
      .catch(() => setBranches([]));
  };
  const current = c.branch ?? c.defaultBranch ?? branches?.[0];
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-[7px] bg-[#23301a] py-0.5 pr-1 pl-2.5 font-mono text-xs text-[#ddf5a0]">
      <span className="truncate">{c.spec}</span>
      {name && (
        <select
          aria-label={`Branch for ${c.spec}`}
          title="Branch to check out"
          value={current ?? ""}
          onFocus={load}
          onMouseDown={load}
          onChange={(e) => onBranch(e.target.value, branches?.[0] ?? c.defaultBranch ?? e.target.value)}
          className={`max-w-32 rounded bg-transparent text-[11px] text-[#b5cf82] ${FOCUS}`}
        >
          {!branches && <option value={current ?? ""}>{current ? `#${current}` : "default branch"}</option>}
          {branches?.map((b, i) => (
            <option key={b} value={b}>
              #{b}
              {i === 0 ? " (default)" : ""}
            </option>
          ))}
        </select>
      )}
      <button type="button" aria-label={`Remove ${c.spec}`} onClick={onRemove} className={`rounded px-1 ${FOCUS}`}>
        ×
      </button>
    </span>
  );
}
