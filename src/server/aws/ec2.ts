import {
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  CancelSpotInstanceRequestsCommand,
  DescribeInstancesCommand,
  DescribeImagesCommand,
  DescribeSubnetsCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeSpotPriceHistoryCommand,
  GetSpotPlacementScoresCommand,
  type Instance,
  type InstanceStateName,
  type ResourceType,
  type _InstanceType,
  type Tag,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { awsGeneration, awsRegion, awsRegions, clientConfig, IMAGE_VARIANTS, PARAM_PREFIX, PARAMS, TAG_APP, TAG_WORKSPACE, type ImageVariant } from "./config";
import { sshPublicKey } from "./keys";
import type { Machine, Market } from "./machines";

// ---- Clients and the stack's parameters ------------------------------------

const g = globalThis as unknown as {
  __csEc2?: Map<string, EC2Client>;
  __csSsm?: Map<string, SSMClient>;
  __csInfra?: Map<string, { at: number; params: Promise<Record<string, string>> }>;
  __csSpot?: Map<string, { at: number; prices: Promise<Record<string, number>> }>;
  __csOffered?: Map<string, { at: number; types: Promise<Set<string>> }>;
};

function cached<T>(map: Map<string, T>, region: string, make: () => T): T {
  const key = `${awsGeneration()}:${region}`;
  let c = map.get(key);
  if (!c) map.set(key, (c = make()));
  return c;
}

export function ec2(region = awsRegion()): EC2Client {
  return cached((g.__csEc2 ??= new Map()), region, () => new EC2Client(clientConfig(region)));
}

function ssm(region: string): SSMClient {
  return cached((g.__csSsm ??= new Map()), region, () => new SSMClient(clientConfig(region)));
}

const INFRA_TTL_MS = 10 * 60_000; // AMI params move when Image Builder publishes a new image

/** Every SSM parameter under /codespace in the region, as name → value. */
async function infraParams(region: string): Promise<Record<string, string>> {
  const map = (g.__csInfra ??= new Map());
  const key = `${awsGeneration()}:${region}`;
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < INFRA_TTL_MS) return hit.params;
  const params = (async () => {
    const out: Record<string, string> = {};
    let NextToken: string | undefined;
    do {
      const res = await ssm(region).send(new GetParametersByPathCommand({ Path: PARAM_PREFIX, Recursive: true, NextToken }));
      for (const p of res.Parameters ?? []) if (p.Name && p.Value) out[p.Name] = p.Value;
      NextToken = res.NextToken;
    } while (NextToken);
    return out;
  })();
  map.set(key, { at: Date.now(), params });
  params.catch(() => map.delete(key)); // don't cache failures
  return params;
}

function requiredParams(): string[] {
  return [
    PARAMS.subnetIds,
    PARAMS.securityGroupId,
    PARAMS.instanceProfileArn,
    ...IMAGE_VARIANTS.flatMap((v) => [PARAMS.launchTemplateId(v), PARAMS.amiId(v)]),
  ];
}

type Readiness = { ok: boolean; missing: string[]; /** variants with a launch template and a built AMI */ variants: Set<ImageVariant> };

async function readiness(region: string): Promise<Readiness> {
  try {
    const p = await infraParams(region);
    const missing = requiredParams().filter((n) => !p[n]);
    const amis = IMAGE_VARIANTS.map((v) => ({ v, name: PARAMS.amiId(v), id: p[PARAMS.amiId(v)] })).filter((a) => a.id);
    const built = await ownedAmis(amis.map((a) => a.id), region);
    for (const a of amis) if (!built.has(a.id)) missing.push(unbuilt(a.name));
    const network = [PARAMS.subnetIds, PARAMS.securityGroupId].every((n) => p[n]);
    const variants = new Set(amis.filter((a) => network && built.has(a.id) && p[PARAMS.launchTemplateId(a.v)]).map((a) => a.v));
    return { ok: missing.length === 0, missing, variants };
  } catch {
    return { ok: false, missing: requiredParams(), variants: new Set() };
  }
}

export async function infraStatus(region = awsRegion()): Promise<{ ok: boolean; missing: string[] }> {
  const { ok, missing } = await readiness(region);
  return { ok, missing };
}

/** infraStatus for every region in awsRegions(), home first. */
export async function regionsStatus(): Promise<Array<{ region: string; ok: boolean; missing: string[] }>> {
  return Promise.all(awsRegions().map(async (region) => ({ region, ...(await infraStatus(region)) })));
}

const unbuilt = (paramName: string) => `${paramName} (not built yet: run the Image Builder pipeline)`;

const owned = new Set<string>(); // region:ami. An AMI's owner never changes, so hits are cached for good

/**
 * Until Image Builder has run, the AMI params hold the stock parent image, which lacks the
 * workspace setup (sshd AcceptEnv, Claude Code...). Only images in this account count as built.
 */
async function ownedAmis(ids: string[], region: string): Promise<Set<string>> {
  // One call per image: a single unknown ID would fail a batched DescribeImages for all of them.
  const check = async (id: string) => {
    try {
      const res = await ec2(region).send(new DescribeImagesCommand({ ImageIds: [id], Owners: ["self"] }));
      if (res.Images?.length) owned.add(`${region}:${id}`);
    } catch (err) {
      if (!/^InvalidAMIID/.test(code(err))) throw err; // a missing AMI just isn't ours
    }
  };
  await Promise.all(ids.filter((id) => !owned.has(`${region}:${id}`)).map(check));
  return new Set(ids.filter((id) => owned.has(`${region}:${id}`)));
}

async function param(name: string, region: string): Promise<string> {
  const v = (await infraParams(region))[name];
  if (!v) throw new Error(`Missing ${name}. Deploy the infra/ stack in ${region}.`);
  return v;
}

// ---- Errors -----------------------------------------------------------------

const CAPACITY = ["InsufficientInstanceCapacity", "InsufficientCapacity", "InsufficientHostCapacity", "Unsupported", "SpotMaxPriceTooLow"];

function code(err: unknown): string {
  return (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? "";
}

function isCapacity(err: unknown) {
  return CAPACITY.includes(code(err));
}

/** Turns the AWS errors people actually hit into something they can act on. */
export function explainAwsError(err: unknown, ctx: { type?: string; market?: Market; region?: string } = {}): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const where = ctx.region ? ` in ${ctx.region}` : "";
  switch (code(err)) {
    case "VcpuLimitExceeded":
      return new Error(
        `AWS vCPU quota reached for ${ctx.type ?? "this instance type"}${where}. Raise the ${
          ctx.market === "spot" ? "Spot" : "On-Demand"
        } quota for its family (Standard, G and VT, or P) in Service Quotas. (${msg})`,
      );
    case "MaxSpotInstanceCountExceeded":
      return new Error(`AWS Spot request limit reached${where}. Raise the Spot quota in Service Quotas, or use on-demand. (${msg})`);
    case "InsufficientInstanceCapacity":
    case "InsufficientCapacity":
    case "InsufficientHostCapacity":
      return new Error(`AWS has no ${ctx.market === "spot" ? "spot " : ""}capacity for ${ctx.type ?? "this instance type"}${where} right now. Try again later, or pick another type or market. (${msg})`);
    case "Unsupported":
      return new Error(`${ctx.type ?? "This instance type"} isn't offered in any of the stack's availability zones${where}. (${msg})`);
    case "SpotMaxPriceTooLow":
      return new Error(`Spot price for ${ctx.type ?? "this instance type"}${where} is above the limit. Try on-demand. (${msg})`);
    case "ParameterNotFound":
      return new Error(`The Codespace infrastructure isn't deployed${where}. Deploy the infra/ stack in ${ctx.region ?? awsRegion()}.`);
    case "UnauthorizedOperation":
    case "AccessDeniedException":
    case "AccessDenied":
      return new Error(`AWS denied the request. Check that your profile has the Codespace app policy from the infra/ stack. (${msg})`);
    case "ExpiredToken":
    case "ExpiredTokenException":
    case "CredentialsProviderError":
      return new Error(`AWS credentials expired or missing. Run \`aws sso login\` (or check Settings). (${msg})`);
    default:
      return err instanceof Error ? err : new Error(msg);
  }
}

// ---- Launch -----------------------------------------------------------------

const rootDevices = new Map<string, { name: string; snapshotGb: number }>();

/** The AMI's root device and its snapshot size: a root volume can't be smaller than the snapshot. */
async function rootDevice(amiId: string, region: string): Promise<{ name: string; snapshotGb: number }> {
  const hit = rootDevices.get(`${region}:${amiId}`);
  if (hit) return hit;
  const res = await ec2(region).send(new DescribeImagesCommand({ ImageIds: [amiId] }));
  const img = res.Images?.[0];
  const name = img?.RootDeviceName;
  if (!name) throw new Error(`AMI ${amiId} not found in ${region}. Rebuild the image or redeploy the infra/ stack.`);
  const snapshotGb = img.BlockDeviceMappings?.find((b) => b.DeviceName === name)?.Ebs?.VolumeSize ?? 0;
  const dev = { name, snapshotGb };
  rootDevices.set(`${region}:${amiId}`, dev);
  return dev;
}

type Placement = { subnetId: string; az: string; azId: string };

/** The stack's subnets whose AZ offers the type, best first: spot by placement score, on-demand in stack order. */
async function placements(type: string, market: Market, region: string): Promise<Placement[]> {
  const ids = (await param(PARAMS.subnetIds, region)).split(",").map((s) => s.trim()).filter(Boolean);
  const [subnets, offerings] = await Promise.all([
    ec2(region).send(new DescribeSubnetsCommand({ SubnetIds: ids })),
    ec2(region).send(
      new DescribeInstanceTypeOfferingsCommand({ LocationType: "availability-zone", Filters: [{ Name: "instance-type", Values: [type] }] }),
    ),
  ]);
  const offered = new Set((offerings.InstanceTypeOfferings ?? []).map((o) => o.Location));
  const byId = new Map((subnets.Subnets ?? []).map((s) => [s.SubnetId, s]));
  const all = ids
    .map((id) => byId.get(id))
    .filter((s) => s?.AvailabilityZone && offered.has(s.AvailabilityZone))
    .map((s) => ({ subnetId: s!.SubnetId!, az: s!.AvailabilityZone!, azId: s!.AvailabilityZoneId ?? "" }));
  if (!all.length) throw new Error(`${type} isn't offered in any of the stack's availability zones in ${region}. Pick another type.`);
  if (market !== "spot") return all;
  try {
    const res = await ec2(region).send(
      new GetSpotPlacementScoresCommand({ InstanceTypes: [type], TargetCapacity: 1, SingleAvailabilityZone: true, RegionNames: [region] }),
    );
    const score = new Map((res.SpotPlacementScores ?? []).map((s) => [s.AvailabilityZoneId, s.Score ?? 0]));
    return [...all].sort((a, b) => (score.get(b.azId) ?? 0) - (score.get(a.azId) ?? 0));
  } catch {
    return all; // scores are advice (and rate-limited); capacity errors still move us along
  }
}

function userData(): string {
  // Deferred to the final stage so cloud-init's own ssh module can't rewrite the file after us.
  const yaml = [
    "#cloud-config",
    "disable_root: false",
    "write_files:",
    "  - path: /root/.ssh/authorized_keys",
    "    owner: root:root",
    '    permissions: "0600"',
    "    append: true",
    "    defer: true",
    "    content: |",
    `      ${sshPublicKey()}`,
    "",
  ].join("\n");
  return Buffer.from(yaml).toString("base64");
}

export type Launched = { instanceId: string; az: string; volumeGb: number; hibernate: boolean };

/** Hibernation writes RAM to the root volume, so it needs that much room on top of the disk. */
export function rootVolumeGb(m: Machine, diskGb: number): number {
  return diskGb + (m.hibernate ? Math.ceil(m.memoryGib) : 0);
}

export async function launchInstance(opts: { workspaceId: string; machine: Machine; market: Market; diskGb: number; region?: string }): Promise<Launched> {
  const { workspaceId, machine: m, market } = opts;
  const region = opts.region ?? awsRegion();
  const ctx = { type: m.type, market, region };
  try {
    const [templateId, amiId] = await Promise.all([param(PARAMS.launchTemplateId(m.variant), region), param(PARAMS.amiId(m.variant), region)]);
    if (!(await ownedAmis([amiId], region)).has(amiId)) throw new Error(`Can't launch: ${unbuilt(PARAMS.amiId(m.variant))}.`);
    const root = await rootDevice(amiId, region);
    const device = root.name;
    // GPU AMIs (the Deep Learning base) ship a root snapshot bigger than the smallest disk step.
    const volumeGb = rootVolumeGb(m, Math.max(opts.diskGb, root.snapshotGb));
    const tags: Tag[] = [{ ...TAG_APP }, { Key: TAG_WORKSPACE, Value: workspaceId }, { Key: "Name", Value: `codespace-${workspaceId}` }];
    const resources: ResourceType[] = ["instance", "volume", ...(market === "spot" ? (["spot-instances-request"] as const) : [])];
    const nonce = Date.now().toString(36);
    let last: unknown;
    for (const p of await placements(m.type, market, region)) {
      try {
        const res = await ec2(region).send(
          new RunInstancesCommand({
            LaunchTemplate: { LaunchTemplateId: templateId, Version: "$Default" },
            InstanceType: m.type as _InstanceType,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: p.subnetId,
            BlockDeviceMappings: [{ DeviceName: device, Ebs: { VolumeSize: volumeGb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }],
            HibernationOptions: m.hibernate ? { Configured: true } : undefined,
            InstanceMarketOptions:
              market === "spot"
                ? { MarketType: "spot", SpotOptions: { SpotInstanceType: "persistent", InstanceInterruptionBehavior: m.hibernate ? "hibernate" : "stop" } }
                : undefined,
            TagSpecifications: resources.map((ResourceType) => ({ ResourceType, Tags: tags })),
            UserData: userData(),
            // Same token across the SDK's own retries, fresh per launch attempt and subnet.
            ClientToken: `${workspaceId}-${nonce}-${p.subnetId}`.slice(0, 64),
          }),
        );
        const inst = res.Instances?.[0];
        if (!inst?.InstanceId) throw new Error("RunInstances returned no instance");
        return { instanceId: inst.InstanceId, az: inst.Placement?.AvailabilityZone ?? p.az, volumeGb, hibernate: m.hibernate };
      } catch (err) {
        if (!isCapacity(err)) throw err;
        last = err;
      }
    }
    throw last ?? new Error(`No subnet could launch ${m.type}`);
  } catch (err) {
    throw explainAwsError(err, ctx);
  }
}

// ---- Lifecycle --------------------------------------------------------------

export type InstanceInfo = {
  state: InstanceStateName;
  /** StateReason.Code, e.g. "Client.UserInitiatedShutdown" or "Server.SpotInstanceShutdown". */
  stateReason: string | null;
  stateMessage: string | null;
  spot: boolean;
  az: string | null;
  hibernate: boolean;
};

async function rawInstance(id: string, region: string): Promise<Instance | null> {
  try {
    const res = await ec2(region).send(new DescribeInstancesCommand({ InstanceIds: [id] }));
    return res.Reservations?.[0]?.Instances?.[0] ?? null;
  } catch (err) {
    if (code(err) === "InvalidInstanceID.NotFound" || code(err) === "InvalidInstanceID.Malformed") return null;
    throw explainAwsError(err, { region });
  }
}

/** null once the instance is gone entirely (terminated instances drop out after about an hour). */
export async function describeInstance(id: string, region = awsRegion()): Promise<InstanceInfo | null> {
  const i = await rawInstance(id, region);
  return i ? info(i) : null;
}

function info(i: Instance): InstanceInfo {
  return {
    state: (i.State?.Name ?? "pending") as InstanceStateName,
    stateReason: i.StateReason?.Code ?? null,
    stateMessage: i.StateReason?.Message ?? null,
    spot: i.InstanceLifecycle === "spot",
    az: i.Placement?.AvailabilityZone ?? null,
    hibernate: i.HibernationOptions?.Configured ?? false,
  };
}

/** Several instances in one call. Missing IDs (gone, or too new to be listed yet) map to null. */
export async function describeInstances(ids: string[], region = awsRegion()): Promise<Map<string, InstanceInfo | null>> {
  const out = new Map<string, InstanceInfo | null>(ids.map((id) => [id, null]));
  if (!ids.length) return out;
  try {
    let NextToken: string | undefined;
    do {
      // A filter rather than InstanceIds, which fails the whole call if one ID is unknown.
      const res = await ec2(region).send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-id", Values: ids }], NextToken }));
      for (const r of res.Reservations ?? []) for (const i of r.Instances ?? []) if (i.InstanceId) out.set(i.InstanceId, info(i));
      NextToken = res.NextToken || undefined;
    } while (NextToken);
  } catch (err) {
    throw explainAwsError(err, { region });
  }
  return out;
}

/** AWS stopped (or hibernated) it to reclaim spot capacity. */
export function spotInterrupted(info: InstanceInfo): boolean {
  return /^Server\.Spot/.test(info.stateReason ?? "");
}

export async function startInstance(id: string, region = awsRegion()) {
  try {
    await ec2(region).send(new StartInstancesCommand({ InstanceIds: [id] }));
  } catch (err) {
    throw explainAwsError(err, { region });
  }
}

/** Hibernates only when asked and the instance was launched for it; otherwise a plain stop. */
export async function stopInstance(id: string, opts: { hibernate?: boolean } = {}, region = awsRegion()) {
  const info = opts.hibernate ? await describeInstance(id, region) : null;
  const hibernate = !!info?.hibernate;
  try {
    await ec2(region).send(new StopInstancesCommand({ InstanceIds: [id], Hibernate: hibernate }));
  } catch (err) {
    // Right after boot the hibernation agent isn't ready yet; a plain stop still keeps the disk.
    if (!hibernate || !/^Unsupported/.test(code(err))) throw explainAwsError(err, { region });
    await ec2(region).send(new StopInstancesCommand({ InstanceIds: [id] }));
  }
}

/** Terminates and cancels the persistent spot request first, which would otherwise relaunch it. */
export async function terminateInstance(id: string, region = awsRegion()) {
  const i = await rawInstance(id, region);
  if (!i) return;
  try {
    if (i.SpotInstanceRequestId) {
      await ec2(region).send(new CancelSpotInstanceRequestsCommand({ SpotInstanceRequestIds: [i.SpotInstanceRequestId] }));
    }
    if (i.State?.Name !== "terminated") await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [id] }));
  } catch (err) {
    if (code(err) === "InvalidInstanceID.NotFound") return;
    throw explainAwsError(err, { region });
  }
}

/** DescribeInstances is eventually consistent: a just-launched instance can be NotFound for a while. */
export const NOT_FOUND_GRACE_MS = 60_000;

/**
 * Polls until the instance reaches `state`; throws if it ends up terminated or gone instead.
 * NotFound is tolerated until the instance has been seen once, for up to NOT_FOUND_GRACE_MS.
 */
export async function waitForState(id: string, state: InstanceStateName, opts: { timeoutMs?: number; region?: string } = {}): Promise<InstanceInfo> {
  const region = opts.region ?? awsRegion();
  const t0 = Date.now();
  const deadline = t0 + (opts.timeoutMs ?? 600_000);
  let seen = false;
  for (;;) {
    const info = await describeInstance(id, region);
    if (info?.state === state) return info;
    if (!info && !seen && Date.now() - t0 < NOT_FOUND_GRACE_MS) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    seen = true;
    if (!info || (info.state === "terminated" && state !== "terminated")) {
      throw new Error(`Instance ${id} was terminated${info?.stateMessage ? `: ${info.stateMessage}` : ""}`);
    }
    if (state === "running" && info.state === "stopped" && spotInterrupted(info)) {
      throw new Error(`AWS reclaimed the spot capacity for ${id} before it finished starting`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id} to be ${state} (it is ${info.state})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- Spot prices ------------------------------------------------------------

const SPOT_TTL_MS = 5 * 60_000;

/** Lowest current Linux spot price per type across the region's AZs ($/hr). Types without a price are left out. */
export async function spotPrices(types: string[], region = awsRegion()): Promise<Record<string, number>> {
  if (!types.length) return {};
  const map = (g.__csSpot ??= new Map());
  const key = `${awsGeneration()}:${region}:${[...types].sort().join(",")}`;
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < SPOT_TTL_MS) return hit.prices;
  const prices = (async () => {
    const newest = new Map<string, { at: number; price: number }>(); // per type|AZ
    let NextToken: string | undefined;
    do {
      const res = await ec2(region).send(
        new DescribeSpotPriceHistoryCommand({ InstanceTypes: types as _InstanceType[], ProductDescriptions: ["Linux/UNIX"], StartTime: new Date(), NextToken }),
      );
      for (const p of res.SpotPriceHistory ?? []) {
        const k = `${p.InstanceType}|${p.AvailabilityZone}`;
        const at = p.Timestamp?.getTime() ?? 0;
        const price = Number(p.SpotPrice);
        if (Number.isFinite(price) && (newest.get(k)?.at ?? -1) < at) newest.set(k, { at, price });
      }
      NextToken = res.NextToken || undefined;
    } while (NextToken);
    const out: Record<string, number> = {};
    for (const [k, { price }] of newest) {
      const type = k.split("|")[0];
      out[type] = Math.min(out[type] ?? Infinity, price);
    }
    return out;
  })();
  map.set(key, { at: Date.now(), prices });
  prices.catch(() => map.delete(key));
  return prices;
}

// ---- Choosing a region ------------------------------------------------------

const OFFERED_TTL_MS = 60 * 60_000;

/** The subset of `types` offered anywhere in the region, cached for an hour. */
async function offeredIn(region: string, types: string[]): Promise<Set<string>> {
  const map = (g.__csOffered ??= new Map());
  const key = `${awsGeneration()}:${region}:${[...types].sort().join(",")}`;
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < OFFERED_TTL_MS) return hit.types;
  const offered = (async () => {
    const out = new Set<string>();
    let NextToken: string | undefined;
    do {
      const res = await ec2(region).send(
        new DescribeInstanceTypeOfferingsCommand({ LocationType: "region", Filters: [{ Name: "instance-type", Values: types }], NextToken }),
      );
      for (const o of res.InstanceTypeOfferings ?? []) if (o.InstanceType) out.add(o.InstanceType);
      NextToken = res.NextToken || undefined;
    } while (NextToken);
    return out;
  })();
  map.set(key, { at: Date.now(), types: offered });
  offered.catch(() => map.delete(key));
  return offered;
}

/** For each type, the regions in awsRegions() that offer it. A region whose lookup fails is left out. */
export async function offeredRegions(types: string[]): Promise<Record<string, string[]>> {
  const regions = awsRegions();
  const sets = await Promise.all(regions.map((r) => offeredIn(r, types).catch(() => new Set<string>())));
  return Object.fromEntries(types.map((t) => [t, regions.filter((_, i) => sets[i].has(t))]));
}

/** Spot placement score (1-10) per region for one instance of `type`, in a single call from the home region. */
async function regionScores(type: string, regions: string[]): Promise<Record<string, number>> {
  try {
    const res = await ec2(awsRegion()).send(
      new GetSpotPlacementScoresCommand({ InstanceTypes: [type], TargetCapacity: 1, SingleAvailabilityZone: false, RegionNames: regions }),
    );
    return Object.fromEntries((res.SpotPlacementScores ?? []).filter((s) => s.Region).map((s) => [s.Region!, s.Score ?? 0]));
  } catch {
    return {}; // advice only, and rate-limited
  }
}

/**
 * The region an "auto" workspace launches in. Candidates have the infra deployed, a built AMI for
 * the machine's variant, and offer the type. Spot: cheapest current price, ties to the better
 * placement score. On-demand costs the same everywhere: best placement score, ties to awsRegions() order.
 */
export async function resolveRegion(m: Machine, market: Market): Promise<string> {
  const regions = awsRegions();
  const [ready, offered] = await Promise.all([Promise.all(regions.map(readiness)), offeredRegions([m.type])]);
  const why: string[] = [];
  const candidates = regions.filter((r, i) => {
    if (!ready[i].variants.has(m.variant)) why.push(`${r}: infra or ${m.variant} image not ready`);
    else if (!offered[m.type].includes(r)) why.push(`${r}: ${m.type} not offered`);
    else return true;
    return false;
  });
  if (!candidates.length) throw new Error(`No region can run ${m.type} right now (${why.join("; ")}). Check Settings.`);
  if (candidates.length === 1) return candidates[0];
  const [scores, prices] = await Promise.all([
    regionScores(m.type, candidates),
    market === "spot" ? Promise.all(candidates.map((r) => spotPrices([m.type], r).then((p) => p[m.type], () => undefined))) : [],
  ]);
  const price = (r: string) => (market === "spot" ? (prices[candidates.indexOf(r)] ?? Infinity) : 0);
  return [...candidates].sort((a, b) => price(a) - price(b) || (scores[b] ?? 0) - (scores[a] ?? 0) || regions.indexOf(a) - regions.indexOf(b))[0];
}
