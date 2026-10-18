"use client";

import { useState, type ReactNode } from "react";
import { dollars, gpuShare, type Machine, type MachinesInfo, type Market, type RegionStatus } from "@/lib/api";
import { Segmented } from "./ui";

/** gp3 storage, us-east-1, per GB-month. The disk is billed while it exists, running or not. */
const GP3_GB_MONTH = 0.08;
const HOURS_PER_MONTH = 730;

/** Mirrors `PARAMS.amiId` in src/server/aws/config.ts, which can't be imported client-side. */
const AMI_PARAM = "/codespace/ami/";
/** AWS's base-price US regions: `onDemandHr` in machines.ts holds in each of them. */
export const BASE_PRICE_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];

/** Why this region can't run this type, or null when it can. Unknown offerings count as offered. */
export function regionBlocker(r: RegionStatus, m: Machine, offered: MachinesInfo["offered"]): string | null {
  const params = r.missing.filter((n) => n.startsWith("/"));
  // A failed or timed-out status check leaves no parameter names to go on.
  if (!r.ok && params.length < r.missing.length) return "status unknown";
  if (params.some((n) => !n.startsWith(AMI_PARAM))) return "infra not deployed";
  if (params.includes(AMI_PARAM + m.variant)) return "image not built";
  if (!r.ok && !params.length) return "status unknown";
  const where = offered[m.type];
  if (where && !where.includes(r.region)) return "type not offered";
  return null;
}

/** The lowest spot price for a type across regions that can run it. */
export function bestSpot(info: MachinesInfo, m: Machine): { region: string; price: number } | null {
  let best: { region: string; price: number } | null = null;
  for (const r of info.regions) {
    const price = info.spot[r.region]?.[m.type];
    if (price && !regionBlocker(r, m, info.offered) && (!best || price < best.price)) best = { region: r.region, price };
  }
  return best;
}

/**
 * What "Cheapest" resolves to, following the server's rules as far as the client can see them:
 * spot takes the lowest spot price; on-demand prices are equal, so the first ready region wins
 * (the server may prefer a better placement score).
 */
export function resolveCheapest(info: MachinesInfo, m: Machine, market: Market): string | null {
  if (market === "spot") {
    const best = bestSpot(info, m);
    if (best) return best.region;
  }
  return info.regions.find((r) => !regionBlocker(r, m, info.offered))?.region ?? null;
}

type Section = { title: string; hint?: string; rows: Machine[] };

function sections(machines: Machine[], group: "cpu" | "gpu"): Section[] {
  if (group === "cpu") {
    const cpus = machines.filter((m) => !m.gpu);
    return [
      { title: "Graviton · arm64", hint: "Cheapest per core. Most tools ship arm64 builds.", rows: cpus.filter((m) => m.arch === "arm64") },
      { title: "Intel / AMD · x86_64", hint: "For tools without arm64 builds.", rows: cpus.filter((m) => m.arch === "x86_64") },
    ].filter((s) => s.rows.length);
  }
  // One section per GPU model, in catalog order. Partitioned and whole GPUs of a model share it.
  const byName = new Map<string, Machine[]>();
  for (const m of machines) if (m.gpu) byName.set(m.gpu.name, [...(byName.get(m.gpu.name) ?? []), m]);
  return [...byName].map(([name, rows]) => ({ title: name, hint: rows.every((m) => m.arch === "arm64") ? "Graviton · arm64" : undefined, rows }));
}

/** What the instance costs per hour, and what the root volume costs. */
export function estimate(m: Machine, market: Market, diskGb: number, spotHr: number | undefined) {
  const instanceHr = market === "spot" && spotHr ? spotHr : m.onDemandHr;
  // Hibernation writes RAM to the root volume, so those instances get room for it on top.
  const volumeGb = diskGb + (m.hibernate ? Math.ceil(m.memoryGib) : 0);
  const diskMonth = volumeGb * GP3_GB_MONTH;
  return { instanceHr, diskMonth, volumeGb, totalHr: instanceHr + diskMonth / HOURS_PER_MONTH, spotKnown: market !== "spot" || !!spotHr };
}

export function InstancePicker({ info, value, market, onChange }: { info: MachinesInfo; value: string; market: Market; onChange: (type: string) => void }) {
  const selected = info.machines.find((m) => m.type === value);
  const [group, setGroup] = useState<"cpu" | "gpu">(selected?.gpu ? "gpu" : "cpu");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-text-2">Instance</span>
        <Segmented
          className="ml-auto"
          label="Instance group"
          value={group}
          onChange={setGroup}
          options={[
            { value: "cpu", label: "CPU" },
            { value: "gpu", label: "GPU" },
          ]}
        />
      </div>

      <div role="radiogroup" aria-label="Instance type" className="max-h-[300px] overflow-y-auto rounded-[10px] border border-line-2 bg-panel-2">
        {group === "gpu" && (
          <p className="border-b border-line px-3 py-2 text-xs leading-relaxed text-muted">
            GPU types need a raised vCPU quota: AWS console → Service Quotas → EC2 → “Running On-Demand G and VT instances” (or the Spot one). New accounts start at 0.
          </p>
        )}
        {sections(info.machines, group).map((s) => (
          <div key={s.title}>
            <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-line bg-panel-2 px-3 pt-2.5 pb-1.5">
              <span className="label">{s.title}</span>
              {s.hint && <span className="truncate text-[11px] text-faint">{s.hint}</span>}
            </div>
            {s.rows.map((m) => (
              <Row key={m.type} m={m} on={m.type === value} market={market} spot={bestSpot(info, m)} onPick={() => onChange(m.type)} />
            ))}
          </div>
        ))}
      </div>

      {selected && <SelectedNotes m={selected} />}
    </div>
  );
}

function Row({ m, on, market, spot, onPick }: { m: Machine; on: boolean; market: Market; spot: { region: string; price: number } | null; onPick: () => void }) {
  const off = spot ? Math.round((1 - spot.price / m.onDemandHr) * 100) : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 ${
        on ? "bg-[#2a2d27] shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-panel-3"
      }`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">{m.type}</span>
          {m.note && (
            <span title={m.note} className="rounded border border-line-2 px-1 text-[10px] text-muted">
              burstable
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-muted">
          {m.gpu && (
            <span className="text-gpu">
              {gpuShare(m.gpu)} · {m.gpu.vramGb} GB VRAM ·{" "}
            </span>
          )}
          {m.vcpu} vCPU · {m.memoryGib} GiB
        </span>
      </span>
      <span className="text-right font-mono text-xs leading-snug">
        <span className={`block ${market === "on-demand" ? "text-text" : "text-faint"}`}>{dollars(m.onDemandHr)}/hr</span>
        {spot ? (
          <span className={`block ${market === "spot" ? "text-text" : "text-faint"}`}>
            spot {dollars(spot.price)}
            {off !== null && off > 0 && <span className="text-ok"> −{off}%</span>}
            <span className="block text-[10px] text-faint">{spot.region}</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SelectedNotes({ m }: { m: Machine }) {
  return (
    <div className="flex flex-col gap-1 text-xs leading-relaxed text-muted">
      <span>
        {m.arch === "arm64"
          ? "arm64 (Graviton): x86-only binaries and Docker images won’t run. Pick an x86_64 type for those."
          : "x86_64: runs anything built for Intel/AMD Linux."}
      </span>
      {m.note && <span>{m.note}.</span>}
      {!m.hibernate && <span className="text-[#e8d3a6]">GPU types can’t hibernate, so pausing stops the instance. Files are kept; running processes end.</span>}
    </div>
  );
}

/** "Cheapest" plus one entry per configured region, each with its price for the selected type. */
export function RegionPicker({ info, m, market, value, onChange }: { info: MachinesInfo; m: Machine; market: Market; value: string; onChange: (region: string) => void }) {
  const price = (region: string) => {
    const spot = info.spot[region]?.[m.type];
    if (market === "on-demand") return `${dollars(m.onDemandHr)}/hr`;
    return spot ? `${dollars(spot)}/hr spot` : "spot price unknown";
  };
  const cheapest = resolveCheapest(info, m, market);
  const outside = info.regions.map((r) => r.region).filter((r) => !BASE_PRICE_REGIONS.includes(r));
  const option = (key: string, on: boolean, disabled: boolean, label: ReactNode, detail: ReactNode, title?: string) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      title={title}
      onClick={() => onChange(key)}
      className={`flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left text-xs last:border-b-0 disabled:cursor-not-allowed ${
        on ? "bg-[#2a2d27] shadow-[inset_2px_0_0_var(--accent)]" : disabled ? "" : "hover:bg-panel-3"
      }`}
    >
      <span className={`font-mono ${disabled ? "text-faint" : "text-text"}`}>{label}</span>
      <span className={`ml-auto font-mono ${disabled ? "text-faint" : "text-muted"}`}>{detail}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-text-2">Region</span>
      <div role="radiogroup" aria-label="Region" className="rounded-[10px] border border-line-2 bg-panel-2">
        {option(
          "auto",
          value === "auto",
          !cheapest,
          <>Cheapest{cheapest && <span className="text-muted"> → {cheapest}</span>}</>,
          cheapest ? price(cheapest) : "no region can run this type",
          "Picks the region when the workspace is created",
        )}
        {info.regions.map((r) => {
          const blocker = regionBlocker(r, m, info.offered);
          return option(r.region, value === r.region, !!blocker, r.region, blocker ?? price(r.region), r.error);
        })}
      </div>
      {outside.length > 0 && (
        <span className="text-xs text-faint">
          On-demand prices are for {BASE_PRICE_REGIONS.join(", ")}; {outside.join(", ")} may cost more.
        </span>
      )}
    </div>
  );
}
