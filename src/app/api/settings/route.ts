import { getSecret, githubToken, setSecret } from "@/server/secrets";
import { awsProfile, awsRegion, checkAwsCredentials, resetAws, type AwsStatus } from "@/server/aws/config";
import { infraStatus } from "@/server/aws/ec2";
import { hasSsmPlugin } from "@/server/remote";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PROFILE = /^[\w.+@-]*$/;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Each check is caught on its own, so one failing shows as not-ok in Settings instead of a 500.
export const GET = handle(async () => {
  const [aws, infra, ssmPlugin] = await Promise.all([
    checkAwsCredentials().catch(
      (err): AwsStatus => ({ ok: false, region: awsRegion(), profile: awsProfile() ?? null, error: message(err) }),
    ),
    infraStatus().catch((err): { ok: boolean; missing: string[]; error?: string } => ({ ok: false, missing: [], error: message(err) })),
    Promise.resolve()
      .then(() => hasSsmPlugin())
      .catch(() => false),
  ]);
  return json({
    aws: { ...aws, infra },
    claude: !!getSecret("claude-oauth-token"),
    github: !!githubToken(),
    ssmPlugin,
  });
});

export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as { awsProfile?: string; awsRegion?: string; claudeToken?: string };
  const profile = body.awsProfile?.trim();
  const region = body.awsRegion?.trim();
  if (profile !== undefined && !PROFILE.test(profile)) return json({ error: "That doesn't look like an AWS profile name" }, 400);
  if (region && !REGION.test(region)) return json({ error: `"${region}" isn't an AWS region, like us-east-1` }, 400);

  let awsChanged = false;
  // An empty profile is stored as-is and means the default credential chain.
  if (profile !== undefined && profile !== (awsProfile() ?? "")) {
    setSecret("aws-profile", profile);
    awsChanged = true;
  }
  if (region && region !== awsRegion()) {
    setSecret("aws-region", region);
    awsChanged = true;
  }
  if (awsChanged) resetAws();
  if (body.claudeToken?.trim()) setSecret("claude-oauth-token", body.claudeToken.trim());
  return json({ ok: true });
});
