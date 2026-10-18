import { awsRegions } from "@/server/aws/config";
import { offeredRegions, regionsStatus, spotPrices } from "@/server/aws/ec2";
import { DEFAULT_DISK_GB, DEFAULT_MACHINE, DISK_GB_STEPS, MACHINES } from "@/server/aws/machines";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 4_000;

/**
 * Expired credentials make the SDK retry for many seconds; don't hold the picker for it.
 * A slow lookup still finishes in the background and fills the cache for next time.
 */
async function within<T>(what: string, p: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)))]);
  } catch (err) {
    console.warn(`${what} lookup failed:`, err instanceof Error ? err.message : err);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** The instance picker's data. Region status, offerings and spot prices are live but best-effort. */
export const GET = handle(async () => {
  const types = MACHINES.map((m) => m.type);
  const regions = awsRegions();
  const [status, offered, prices] = await Promise.all([
    within(
      "region status",
      regionsStatus(),
      regions.map((region) => ({ region, ok: false, missing: ["(status lookup timed out)"] })),
    ),
    within("offered regions", offeredRegions(types), {} as Record<string, string[]>),
    // One timeout per region, all in parallel: a slow region leaves only its own prices out.
    Promise.all(regions.map((r) => within(`spot prices in ${r}`, spotPrices(types, r), {} as Record<string, number>))),
  ]);
  const spot = Object.fromEntries(regions.map((r, i) => [r, prices[i]]));
  return json({ machines: MACHINES, defaultType: DEFAULT_MACHINE, diskSteps: DISK_GB_STEPS, defaultDiskGb: DEFAULT_DISK_GB, regions: status, offered, spot });
});
