import { awsRegion } from "@/server/aws/config";
import { spotPrices } from "@/server/aws/ec2";
import { DEFAULT_DISK_GB, DEFAULT_MACHINE, DISK_GB_STEPS, MACHINES } from "@/server/aws/machines";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

/** The instance picker's data. Spot prices are live but optional: the picker works without them. */
export const GET = handle(async () => {
  let spot: Record<string, number> = {};
  try {
    // Expired credentials make the SDK retry for many seconds; don't hold the picker for it.
    // A slow lookup still finishes in the background and fills the cache for next time.
    spot = await Promise.race([
      spotPrices(MACHINES.map((m) => m.type)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 4s")), 4_000)),
    ]);
  } catch (err) {
    console.warn("spot price lookup failed:", err instanceof Error ? err.message : err);
  }
  return json({ machines: MACHINES, defaultType: DEFAULT_MACHINE, diskSteps: DISK_GB_STEPS, defaultDiskGb: DEFAULT_DISK_GB, region: awsRegion(), spot });
});
