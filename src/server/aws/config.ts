import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getSecret } from "../secrets";

/**
 * Where the app finds AWS: a named profile and the regions workspaces may run in, from Settings
 * (Keychain) or the environment. Credentials resolve through the standard chain, so `aws login`
 * and `aws sso login` work. Region is a price decision, not a location one: the defaults are
 * AWS's base-price US regions, which all offer every type in machines.ts.
 */
export const DEFAULT_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];

export function awsRegions(): string[] {
  const raw = getSecret("aws-regions") || process.env.CODESPACE_AWS_REGIONS || "";
  const list = raw.split(",").map((r) => r.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : DEFAULT_REGIONS;
}

/** The home region: images are built here and copied to the others. Default for region-less calls. */
export function awsRegion(): string {
  return awsRegions()[0];
}

/** Days a workspace stays stopped before its disk moves to a snapshot (0 = never). Default 3. */
export const DEFAULT_COLD_AFTER_DAYS = 3;

export function coldAfterDays(): number {
  const raw = getSecret("cold-after-days");
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_COLD_AFTER_DAYS;
}

export function awsProfile(): string | undefined {
  return getSecret("aws-profile") || process.env.AWS_PROFILE || undefined;
}

const g = globalThis as unknown as { __csAwsGen?: number };

/** Bumped when Settings change, so cached clients are rebuilt with the new profile/region. */
export function awsGeneration(): number {
  return g.__csAwsGen ?? 0;
}

export function resetAws() {
  g.__csAwsGen = awsGeneration() + 1;
}

/** Config for any AWS SDK v3 client. */
export function clientConfig(region = awsRegion()) {
  return { region, credentials: fromNodeProviderChain({ profile: awsProfile() }) };
}

export type AwsStatus = { ok: boolean; region: string; profile: string | null; account?: string; arn?: string; error?: string };

export async function checkAwsCredentials(): Promise<AwsStatus> {
  const region = awsRegion();
  const profile = awsProfile() ?? null;
  try {
    const id = await new STSClient(clientConfig(region)).send(new GetCallerIdentityCommand({}));
    return { ok: true, region, profile, account: id.Account, arn: id.Arn };
  } catch (err) {
    return { ok: false, region, profile, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Names shared with the CDK stack in infra/ --------------------------------
// The stack writes these SSM parameters in each region it is deployed to; the app reads them.

export const PARAM_PREFIX = "/codespace";

/** One AMI and launch template per variant. GPU variants carry the NVIDIA driver and CUDA. */
export type ImageVariant = "cpu-arm64" | "cpu-x86" | "gpu-arm64" | "gpu-x86";
export const IMAGE_VARIANTS: ImageVariant[] = ["cpu-arm64", "cpu-x86", "gpu-arm64", "gpu-x86"];

export const PARAMS = {
  /** StringList of public subnet IDs, one per availability zone. */
  subnetIds: `${PARAM_PREFIX}/network/subnet-ids`,
  /** Security group with no inbound rules: SSH arrives through SSM. */
  securityGroupId: `${PARAM_PREFIX}/network/security-group-id`,
  /** Instance profile ARN carrying AmazonSSMManagedInstanceCore. */
  instanceProfileArn: `${PARAM_PREFIX}/iam/instance-profile-arn`,
  /** Launch template ID per variant (AMI via resolve:ssm, gp3 encrypted root, IMDSv2, SG, profile). */
  launchTemplateId: (v: ImageVariant) => `${PARAM_PREFIX}/launch-template/${v}`,
  /** Latest AMI ID per variant, written by the Image Builder distribution. */
  amiId: (v: ImageVariant) => `${PARAM_PREFIX}/ami/${v}`,
} as const;

/** Every instance and volume the app creates carries these tags; IAM conditions key on `app`. */
export const TAG_APP = { Key: "app", Value: "codespace" } as const;
export const TAG_WORKSPACE = "workspace";
