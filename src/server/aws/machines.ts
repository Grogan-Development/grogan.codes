import type { ImageVariant } from "./config";

/**
 * Instance types offered for workspaces. Prices are us-east-1 Linux on-demand (AWS Price List,
 * 2026-10-18) and only guide the picker; spot prices are fetched live. Every CPU type here
 * supports hibernation (Linux, under 150 GiB RAM); no GPU family does, so those stop instead.
 */
export type Machine = {
  type: string;
  arch: "arm64" | "x86_64";
  vcpu: number;
  memoryGib: number;
  /** null for CPU-only. `fraction` is set for partitioned GPUs (g6f). */
  gpu: { name: string; vramGb: number; fraction?: number } | null;
  onDemandHr: number;
  hibernate: boolean;
  variant: ImageVariant;
  note?: string;
};

export type Market = "on-demand" | "spot";
export const MARKETS: Market[] = ["on-demand", "spot"];

const cpu = (type: string, arch: Machine["arch"], vcpu: number, memoryGib: number, onDemandHr: number, note?: string): Machine => ({
  type,
  arch,
  vcpu,
  memoryGib,
  gpu: null,
  onDemandHr,
  hibernate: true,
  variant: arch === "arm64" ? "cpu-arm64" : "cpu-x86",
  note,
});

const gpu = (type: string, vcpu: number, memoryGib: number, name: string, vramGb: number, onDemandHr: number, extra: Partial<Machine> = {}): Machine => ({
  type,
  arch: "x86_64",
  vcpu,
  memoryGib,
  gpu: { name, vramGb },
  onDemandHr,
  hibernate: false,
  variant: "gpu-x86",
  ...extra,
});

const BURST = "Burstable: sustained heavy CPU costs extra credits";

export const MACHINES: Machine[] = [
  // Graviton (arm64): cheapest per core.
  cpu("t4g.medium", "arm64", 2, 4, 0.0336, BURST),
  cpu("t4g.large", "arm64", 2, 8, 0.0672, BURST),
  cpu("t4g.xlarge", "arm64", 4, 16, 0.1344, BURST),
  cpu("m8g.large", "arm64", 2, 8, 0.08976),
  cpu("m8g.xlarge", "arm64", 4, 16, 0.17952),
  cpu("m8g.2xlarge", "arm64", 8, 32, 0.35904),
  cpu("m8g.4xlarge", "arm64", 16, 64, 0.71808),
  cpu("c8g.xlarge", "arm64", 4, 8, 0.15952),
  cpu("c8g.2xlarge", "arm64", 8, 16, 0.31904),
  cpu("r8g.large", "arm64", 2, 16, 0.11782),
  cpu("r8g.xlarge", "arm64", 4, 32, 0.23564),
  // x86, for tools without arm64 builds.
  cpu("m7i.xlarge", "x86_64", 4, 16, 0.2016),
  cpu("m7i.2xlarge", "x86_64", 8, 32, 0.4032),
  cpu("m7a.xlarge", "x86_64", 4, 16, 0.23184),
  cpu("c7i.2xlarge", "x86_64", 8, 16, 0.357),

  // Partitioned L4.
  gpu("g6f.large", 2, 8, "L4", 3, 0.202, { gpu: { name: "L4", vramGb: 3, fraction: 0.125 } }),
  gpu("g6f.xlarge", 4, 16, "L4", 3, 0.2375, { gpu: { name: "L4", vramGb: 3, fraction: 0.125 } }),
  gpu("g6f.2xlarge", 8, 32, "L4", 6, 0.475, { gpu: { name: "L4", vramGb: 6, fraction: 0.25 } }),
  gpu("g6f.4xlarge", 16, 64, "L4", 12, 0.95, { gpu: { name: "L4", vramGb: 12, fraction: 0.5 } }),
  gpu("gr6f.4xlarge", 16, 128, "L4", 12, 1.066, { gpu: { name: "L4", vramGb: 12, fraction: 0.5 } }),
  // T4G on Graviton.
  ...(
    [
      ["g5g.xlarge", 4, 8, 0.42],
      ["g5g.2xlarge", 8, 16, 0.556],
      ["g5g.4xlarge", 16, 32, 0.828],
      ["g5g.8xlarge", 32, 64, 1.372],
    ] as const
  ).map(([t, v, m, p]) => gpu(t, v, m, "T4G", 16, p, { arch: "arm64", variant: "gpu-arm64" })),
  // T4.
  gpu("g4dn.xlarge", 4, 16, "T4", 16, 0.526),
  gpu("g4dn.2xlarge", 8, 32, "T4", 16, 0.752),
  gpu("g4dn.4xlarge", 16, 64, "T4", 16, 1.204),
  gpu("g4dn.8xlarge", 32, 128, "T4", 16, 2.176),
  gpu("g4dn.16xlarge", 64, 256, "T4", 16, 4.352),
  // L4.
  gpu("g6.xlarge", 4, 16, "L4", 24, 0.8048),
  gpu("g6.2xlarge", 8, 32, "L4", 24, 0.9776),
  gpu("g6.4xlarge", 16, 64, "L4", 24, 1.3232),
  gpu("g6.8xlarge", 32, 128, "L4", 24, 2.0144),
  gpu("g6.16xlarge", 64, 256, "L4", 24, 3.3968),
  gpu("gr6.4xlarge", 16, 128, "L4", 24, 1.5392),
  gpu("gr6.8xlarge", 32, 256, "L4", 24, 2.4464),
  // A10G (previous generation).
  gpu("g5.xlarge", 4, 16, "A10G", 24, 1.006),
  gpu("g5.2xlarge", 8, 32, "A10G", 24, 1.212),
  gpu("g5.4xlarge", 16, 64, "A10G", 24, 1.624),
  gpu("g5.8xlarge", 32, 128, "A10G", 24, 2.448),
  gpu("g5.16xlarge", 64, 256, "A10G", 24, 4.096),
  // RTX PRO 4500 Blackwell.
  gpu("g7.2xlarge", 8, 32, "RTX PRO 4500", 32, 2.52),
  gpu("g7.4xlarge", 16, 64, "RTX PRO 4500", 32, 3.04208),
  gpu("g7.8xlarge", 32, 128, "RTX PRO 4500", 32, 4.08624),
  // L40S.
  gpu("g6e.xlarge", 4, 32, "L40S", 48, 1.861),
  gpu("g6e.2xlarge", 8, 64, "L40S", 48, 2.24208),
  gpu("g6e.4xlarge", 16, 128, "L40S", 48, 3.00424),
  gpu("g6e.8xlarge", 32, 256, "L40S", 48, 4.52856),
  gpu("g6e.16xlarge", 64, 512, "L40S", 48, 7.57719),
  // RTX PRO 6000 Blackwell Server.
  gpu("g7e.2xlarge", 8, 64, "RTX PRO 6000", 96, 3.36312),
  gpu("g7e.4xlarge", 16, 128, "RTX PRO 6000", 96, 3.99816),
  gpu("g7e.8xlarge", 32, 256, "RTX PRO 6000", 96, 5.26824),
  // H100: the only single-GPU P instance.
  gpu("p5.4xlarge", 16, 256, "H100", 80, 6.88),
];

export const DEFAULT_MACHINE = "m8g.xlarge";

/** Root volume sizes offered (GiB, gp3). Hibernation also reserves room for RAM on top. */
export const DISK_GB_STEPS = [30, 50, 100, 200, 500];
export const DEFAULT_DISK_GB = 50;

export function machine(type: string): Machine {
  const m = MACHINES.find((x) => x.type === type);
  if (!m) throw new Error(`Unknown instance type "${type}"`);
  return m;
}

/** "m8g.xlarge · 4 vCPU · 16 GiB" or "g6.xlarge · L4 24 GB". */
export function machineLabel(m: Machine): string {
  if (!m.gpu) return `${m.type} · ${m.vcpu} vCPU · ${m.memoryGib} GiB`;
  const share = m.gpu.fraction ? `${m.gpu.fraction * 8}/8 ` : "";
  return `${m.type} · ${share}${m.gpu.name} ${m.gpu.vramGb} GB · ${m.vcpu} vCPU · ${m.memoryGib} GiB`;
}
