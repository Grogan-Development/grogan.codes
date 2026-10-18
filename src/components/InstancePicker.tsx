"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AMI_PARAM, dollars, missingParams, gpuShare, type Machine, type MachinesInfo, type Market, type RegionStatus } from "@/lib/api";
import { FOCUS, Segmented } from "./ui";

/** gp3 storage, us-east-1, per GB-month. The disk is billed while it exists, running or not. */
const GP3_GB_MONTH = 0.08;
const HOURS_PER_MONTH = 730;

/** AWS's base-price US regions: `onDemandHr` in machines.ts holds in each of them. */
export const BASE_PRICE_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];

/** Why this region can't run this type, or null when it can. Unknown offerings count as offered. */
export function regionBlocker(r: RegionStatus, m: Machine, offered: MachinesInfo["offered"]): string | null {
  const params = missingParams(r);
  // A failed or timed-out status check leaves no parameter names to go on.
  if (!r.ok && params.length < r.missing.length) return "status unknown";
  if (params.some((n) => !n.startsWith(AMI_PARAM))) return "infra not deployed";
  if (params.includes(AMI_PARAM + m.variant)) return "image still building";
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

/** What the instance costs per hour, and what the root volume costs. */
export function estimate(m: Machine, market: Market, diskGb: number, spotHr: number | undefined) {
  const instanceHr = market === "spot" && spotHr ? spotHr : m.onDemandHr;
  // Hibernation writes RAM to the root volume, so those instances get room for it on top.
  const volumeGb = diskGb + (m.hibernate ? Math.ceil(m.memoryGib) : 0);
  const diskMonth = volumeGb * GP3_GB_MONTH;
  return { instanceHr, diskMonth, volumeGb, totalHr: instanceHr + diskMonth / HOURS_PER_MONTH, spotKnown: market !== "spot" || !!spotHr };
}

// ---- Filters ------------------------------------------------------------------------------

type Arch = "any" | Machine["arch"];
/** "none", "any", or a GPU key: the model name, with partitioned L4s as "L4 (shared)". */
type GpuFilter = string;
type Filters = { vcpu: number; ram: number; arch: Arch; gpu: GpuFilter; vram: number };

const gpuKey = (m: Machine) => (m.gpu ? (m.gpu.fraction ? `${m.gpu.name} (shared)` : m.gpu.name) : "none");
const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

function matches(m: Machine, f: Filters) {
  if (m.vcpu < f.vcpu || m.memoryGib < f.ram) return false;
  if (f.arch !== "any" && m.arch !== f.arch) return false;
  if (f.gpu === "none") return !m.gpu;
  if (!m.gpu) return false;
  if (f.gpu !== "any" && gpuKey(m) !== f.gpu) return false;
  return m.gpu.vramGb >= f.vram;
}

/** The hourly price that sorts the results: best spot price across ready regions, or on-demand. */
function priceFor(info: MachinesInfo, m: Machine, market: Market) {
  return market === "spot" ? (bestSpot(info, m)?.price ?? m.onDemandHr) : m.onDemandHr;
}

/** Filters derived from a type, so the default selection shows up already matching. */
function filtersFor(m: Machine | undefined): Filters {
  if (!m) return { vcpu: 2, ram: 4, arch: "any", gpu: "none", vram: 0 };
  return { vcpu: m.vcpu, ram: m.memoryGib, arch: "any", gpu: m.gpu ? gpuKey(m) : "none", vram: 0 };
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
      <span className="text-xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const SELECT = `h-7 rounded-lg border border-line bg-bg px-2 text-xs text-text ${FOCUS}`;

/**
 * Pick an instance by what it needs (cores, memory, arch, GPU) rather than by scrolling the
 * catalog. The cheapest match for the chosen market is selected automatically whenever the
 * filters change, until a row is picked by hand. `onChange("")` means nothing matches.
 */
export function InstancePicker({ info, value, market, onChange }: { info: MachinesInfo; value: string; market: Market; onChange: (type: string) => void }) {
  const [filters, setFilters] = useState<Filters>(() => filtersFor(info.machines.find((m) => m.type === value)));
  // The initial default counts as picked by hand, so it stays until a filter moves.
  const [manual, setManual] = useState(true);
  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setManual(false);
  };

  const vcpuSteps = useMemo(() => uniq(info.machines.map((m) => m.vcpu)), [info]);
  const ramSteps = useMemo(() => uniq(info.machines.map((m) => m.memoryGib)), [info]);
  const gpuKeys = useMemo(() => [...new Set(info.machines.filter((m) => m.gpu).map(gpuKey))], [info]);
  const vramSteps = useMemo(
    () => uniq(info.machines.filter((m) => m.gpu && (filters.gpu === "any" || gpuKey(m) === filters.gpu)).map((m) => m.gpu!.vramGb)),
    [info, filters.gpu],
  );

  const results = useMemo(
    () =>
      info.machines
        .filter((m) => matches(m, filters))
        .map((m) => ({ m, price: priceFor(info, m, market) }))
        .sort((a, b) => a.price - b.price),
    [info, filters, market],
  );

  // Keep the selection inside the results: the cheapest match unless one was picked by hand.
  useEffect(() => {
    const cheapest = results[0]?.m.type ?? "";
    const inResults = results.some((r) => r.m.type === value);
    if (!inResults || (!manual && value !== cheapest)) onChange(cheapest);
  }, [results, manual, value, onChange]);

  const selected = results.find((r) => r.m.type === value)?.m;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-text-2">Instance</span>
        <span className="ml-auto text-[11px] text-faint" title="The workspace stack (bash over SSH, Claude Code's Linux build, the XFCE desktop and the AMIs) is Linux-only.">
          Linux · Windows not supported
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-panel-2 p-3">
        <FilterRow label="Min vCPU">
          <Segmented stretch label="Minimum vCPU" value={filters.vcpu} onChange={(vcpu) => set({ vcpu })} options={vcpuSteps.map((v) => ({ value: v, label: String(v) }))} />
        </FilterRow>
        <FilterRow label="Min RAM">
          <Segmented
            stretch
            label="Minimum RAM in GiB"
            value={filters.ram}
            onChange={(ram) => set({ ram })}
            className="[&>button]:px-1"
            options={ramSteps.map((v) => ({ value: v, label: String(v), title: `${v} GiB` }))}
          />
        </FilterRow>
        <FilterRow label="Arch">
          <Segmented
            stretch
            label="Architecture"
            value={filters.arch}
            onChange={(arch) => set({ arch })}
            options={[
              { value: "any", label: "Any" },
              { value: "arm64", label: "arm64", title: "Graviton: cheapest per core" },
              { value: "x86_64", label: "x86_64", title: "Intel/AMD: for tools without arm64 builds" },
            ]}
          />
        </FilterRow>
        <FilterRow label="GPU">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="GPU" value={filters.gpu} onChange={(e) => set({ gpu: e.target.value, vram: 0 })} className={`${SELECT} min-w-0 flex-1`}>
              <option value="none">None</option>
              <option value="any">Any GPU</option>
              {gpuKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            {filters.gpu !== "none" && vramSteps.length > 1 && (
              <select aria-label="Minimum VRAM" value={filters.vram} onChange={(e) => set({ vram: Number(e.target.value) })} className={SELECT}>
                <option value={0}>any VRAM</option>
                {vramSteps.map((v) => (
                  <option key={v} value={v}>
                    ≥ {v} GB VRAM
                  </option>
                ))}
              </select>
            )}
          </div>
        </FilterRow>
        {filters.gpu !== "none" && (
          <p className="text-[11px] leading-relaxed text-faint">
            GPU types need a raised vCPU quota: Service Quotas → EC2 → “Running On-Demand G and VT instances” (or the Spot one). New accounts start at 0.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted">
          {results.length === 0 ? "No matches" : `${results.length} ${results.length === 1 ? "match" : "matches"}, cheapest ${market === "spot" ? "spot" : "on-demand"} first`}
        </span>
        {results.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-line-2 px-3 py-4 text-center text-xs text-muted">Nothing matches. Loosen RAM or GPU.</p>
        ) : (
          <div role="radiogroup" aria-label="Instance type" className="max-h-[220px] overflow-y-auto rounded-[10px] border border-line-2 bg-panel-2">
            {results.map(({ m }) => (
              <Row
                key={m.type}
                m={m}
                on={m.type === value}
                market={market}
                spot={bestSpot(info, m)}
                onPick={() => {
                  setManual(true);
                  onChange(m.type);
                }}
              />
            ))}
          </div>
        )}
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
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-1.5 text-left last:border-b-0 ${FOCUS} focus-visible:ring-inset ${
        on ? "bg-[#2a2d27] shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-panel-3"
      }`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">{m.type}</span>
          <span className="text-[10px] text-faint">{m.arch}</span>
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
        {market === "spot" && spot ? (
          <>
            <span className="block text-text">
              {dollars(spot.price)}/hr{off !== null && off > 0 && <span className="text-ok"> −{off}%</span>}
            </span>
            <span className="block text-[10px] text-faint">spot · {spot.region}</span>
          </>
        ) : (
          <>
            <span className="block text-text">{dollars(m.onDemandHr)}/hr</span>
            {spot && (
              <span className="block text-[10px] text-faint">
                spot {dollars(spot.price)} · {spot.region}
              </span>
            )}
          </>
        )}
      </span>
    </button>
  );
}

function SelectedNotes({ m }: { m: Machine }) {
  return (
    <div className="flex flex-col gap-1 text-xs leading-relaxed text-muted">
      <span>
        {m.arch === "arm64"
          ? "arm64 (Graviton): x86-only binaries and Docker images won’t run. Pick x86_64 for those."
          : "x86_64: runs anything built for Intel/AMD Linux."}
      </span>
      {m.note && <span>{m.note}.</span>}
      {!m.hibernate && <span className="text-[#e8d3a6]">GPU types can’t hibernate, so pausing stops the instance. Files are kept; running processes end.</span>}
    </div>
  );
}

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
      className={`flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left text-xs last:border-b-0 disabled:cursor-not-allowed ${FOCUS} focus-visible:ring-inset ${
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
