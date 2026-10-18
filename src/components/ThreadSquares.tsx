"use client";

import Link from "next/link";
import { timeAgo, type ThreadSummary } from "@/lib/api";

const KINDS: Record<string, { label: string; text: string; fill: string; glow?: boolean }> = {
  waiting: { label: "Needs you", text: "text-warn", fill: "bg-warn" },
  running: { label: "Working", text: "text-accent", fill: "bg-accent", glow: true },
  starting: { label: "Starting", text: "text-accent", fill: "bg-accent", glow: true },
  error: { label: "Ended with an error", text: "text-[#ff8a70]", fill: "bg-bad" },
  idle: { label: "Idle", text: "text-muted", fill: "bg-[#3a3d35]" },
};

/** One square per thread, colored by status; hovering or focusing one shows its card. */
export function ThreadSquares({ workspaceId, threads }: { workspaceId: string; threads: ThreadSummary[] }) {
  if (threads.length === 0) return <span className="text-[13px] text-faint">No threads</span>;
  return (
    <ul aria-label="Threads" className="flex flex-wrap gap-[5px]">
      {threads.map((t) => {
        const k = KINDS[t.status] ?? KINDS.idle;
        return (
          <li key={t.id} className="group relative">
            <Link
              href={`/w/${workspaceId}?thread=${t.id}`}
              aria-label={`${k.label}: ${t.title}`}
              className={`block size-4 rounded-[4px] ${k.fill} ${k.glow ? "shadow-[0_0_0_3px_rgba(200,242,90,.18)]" : ""} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text`}
            />
            <div
              role="tooltip"
              className="pointer-events-none invisible absolute bottom-[calc(100%+10px)] left-1/2 z-30 w-[250px] -translate-x-1/2 rounded-[10px] border border-line-2 bg-panel-3 px-3 py-2.5 opacity-0 shadow-[0_10px_30px_rgba(0,0,0,.5)] transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
            >
              <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${k.text}`}>
                {k.label}
                <span className="ml-auto font-normal text-faint">{timeAgo(t.updated_at)}</span>
              </span>
              <span className="mt-1 block text-[13px] leading-snug font-semibold text-text">{t.title}</span>
              <span className="mt-1 block font-mono text-[11px] text-muted">{t.repo ?? "workspace"}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
