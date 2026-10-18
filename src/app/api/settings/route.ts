import { getSecret, githubToken, setSecret } from "@/server/secrets";
import { awsProfile, awsRegion, awsRegions, checkAwsCredentials, coldAfterDays, resetAws, type AwsStatus } from "@/server/aws/config";
import { regionsStatus } from "@/server/aws/ec2";
import { hasSsmPlugin } from "@/server/remote";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PROFILE = /^[\w.+@-]*$/;

type RegionStatus = { region: string; ok: boolean; missing: string[]; error?: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Each check is caught on its own, so one failing shows as not-ok in Settings instead of a 500.
export const GET = handle(async () => {
  const [aws, regions, ssmPlugin] = await Promise.all([
    checkAwsCredentials().catch(
      (err): AwsStatus => ({ ok: false, region: awsRegion(), profile: awsProfile() ?? null, error: message(err) }),
    ),
    regionsStatus().catch((err): RegionStatus[] => awsRegions().map((region) => ({ region, ok: false, missing: [], error: message(err) }))),
    Promise.resolve()
      .then(() => hasSsmPlugin())
      .catch(() => false),
  ]);
  return json({
    aws: { ...aws, regions },
    claude: !!getSecret("claude-oauth-token"),
    github: !!githubToken(),
    ssmPlugin,
    coldAfterDays: coldAfterDays(),
  });
});

export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as { awsProfile?: string; awsRegions?: string; claudeToken?: string; coldAfterDays?: number | string };
  const cold = body.coldAfterDays === undefined || body.coldAfterDays === "" ? undefined : Number(body.coldAfterDays);
  if (cold !== undefined && !(Number.isInteger(cold) && cold >= 0 && cold <= 365))
    return json({ error: "Cold storage days must be a whole number from 0 to 365" }, 400);
  const profile = body.awsProfile?.trim();
  if (profile !== undefined && !PROFILE.test(profile)) return json({ error: "That doesn't look like an AWS profile name" }, 400);
  // Comma list; the first is the home region, where images are built.
  const regions = body.awsRegions === undefined ? undefined : [...new Set(body.awsRegions.split(",").map((r) => r.trim()).filter(Boolean))];
  const bad = regions?.find((r) => !REGION.test(r));
  if (bad) return json({ error: `"${bad}" isn't an AWS region, like us-east-1` }, 400);

  let awsChanged = false;
  // An empty profile is stored as-is and means the default credential chain.
  if (profile !== undefined && profile !== (awsProfile() ?? "")) {
    setSecret("aws-profile", profile);
    awsChanged = true;
  }
  // An empty list is stored as-is and means the defaults.
  if (regions && regions.join(",") !== awsRegions().join(",")) {
    setSecret("aws-regions", regions.join(","));
    awsChanged = true;
  }
  if (awsChanged) resetAws();
  if (cold !== undefined && cold !== coldAfterDays()) setSecret("cold-after-days", String(cold));
  if (body.claudeToken?.trim()) setSecret("claude-oauth-token", body.claudeToken.trim());
  return json({ ok: true });
});
