"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Keyboard focus ring; mouse clicks don't show it. */
export const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

type Variant = "default" | "primary" | "danger" | "ghost" | "attn";

const VARIANTS: Record<Variant, string> = {
  default: "bg-panel-3 border border-line-2 text-text hover:border-faint",
  primary: "bg-accent text-bg font-semibold border border-transparent hover:brightness-110",
  attn: "bg-warn text-bg font-semibold border border-transparent hover:brightness-110",
  danger: "bg-bad/10 text-bad border border-bad/40 hover:bg-bad/20",
  ghost: "border border-transparent text-muted hover:text-text hover:bg-panel-3",
};

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "icon" }) {
  const sizing = { sm: "h-7 px-2.5 text-xs", md: "h-8 px-3 text-[13px]", icon: "size-8 justify-center" }[size];
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition disabled:opacity-40 disabled:pointer-events-none ${FOCUS} ${sizing} ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-lg bg-panel-2 border border-line-2 px-3 py-1.5 outline-none placeholder:text-faint focus:border-accent ${className}`}
    />
  );
}

/** A row of mutually exclusive options, like the composer's permission modes. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className = "",
  stretch,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  stretch?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={`flex rounded-lg border border-line bg-bg p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-6 rounded-md px-2.5 text-xs font-medium transition ${FOCUS} ${stretch ? "flex-1" : ""} ${
            o.value === value ? "bg-[#2a2d27] text-text" : "text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATE_COLORS: Record<string, string> = {
  started: "bg-accent",
  running: "bg-accent",
  ready: "bg-ok",
  idle: "bg-faint",
  stopped: "bg-faint",
  archiving: "bg-info",
  paused: "bg-info",
  archived: "bg-faint",
  waiting: "bg-warn",
  error: "bg-bad",
  "setup failed": "bg-bad",
};

export function StateDot({ state }: { state: string }) {
  // Every "-ing" state is transient (creating, starting, stopping, archiving…) except running.
  const busy = /ing$/.test(state) && state !== "running";
  return (
    <span
      title={state}
      className={`inline-block size-2 shrink-0 rounded-full ${STATE_COLORS[state] ?? "bg-muted"} ${busy || state === "running" ? "animate-pulse" : ""}`}
    />
  );
}

/** "spot" as an amber badge, since AWS can reclaim it; on-demand is the quiet default. */
export function MarketTag({ market }: { market: string }) {
  if (market !== "spot") return <span className="text-[11px] text-faint">on-demand</span>;
  return (
    <span title="Spot: AWS can reclaim it with 2 minutes' notice. The disk is kept." className="rounded-md bg-warn/15 px-1.5 py-px text-[11px] font-semibold text-warn">
      spot
    </span>
  );
}

/** Shown on a workspace in cold storage, with when it moved there. */
export function ColdTag({ archivedAt }: { archivedAt: number | null }) {
  const when = archivedAt ? new Date(archivedAt).toLocaleString() : "an unknown time";
  return (
    <span
      title={`In cold storage since ${when}. The instance was removed and the disk kept as a snapshot; starting restores it.`}
      className="rounded-md bg-info/15 px-1.5 py-px text-[11px] font-semibold text-info"
    >
      Cold
    </span>
  );
}

export function Logo() {
  return (
    <Link href="/" aria-label="All workspaces" className="flex size-7 items-center justify-center rounded-[7px] bg-accent text-[13px] font-bold text-bg">
      gc
    </Link>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-6"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        // Escape closes the innermost modal only; nested modals stop it here.
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`mt-8 w-full rounded-2xl border border-line bg-bg shadow-2xl sm:mt-12 ${wide ? "max-w-4xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );
}

const ICONS: Record<string, ReactNode> = {
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  stop: <path d="M9 5v14M15 5v14" />,
  play: <path d="M7 4l13 8-13 8z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M6 8v8" />
    </>
  ),
  diff: (
    <>
      <path d="M12 3v8M8 7h8M8 17h8" />
      <rect x="3" y="3" width="18" height="18" rx="3" />
    </>
  ),
  terminal: <path d="M5 8l4 4-4 4M12 17h7" />,
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  ports: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  loadout: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  collapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16M9 10l2 2-2 2" />
    </>
  ),
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  square: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  chevron: <path d="M6 9l6 6 6-6" />,
};

export function Icon({ name, size = 14, className = "" }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {ICONS[name]}
    </svg>
  );
}

/** Spinning ring for a thread Claude is working on. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg role="img" aria-label="Working" width={size} height={size} viewBox="0 0 20 20" className="cs-spin shrink-0">
      <circle cx="10" cy="10" r="7" fill="none" stroke="var(--line-2)" strokeWidth="2.5" />
      <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
