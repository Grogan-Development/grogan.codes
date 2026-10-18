/**
 * Names shared with the app. Keep in sync with `src/server/aws/config.ts` (PARAMS, IMAGE_VARIANTS,
 * TAG_APP). They're copied rather than imported because that module pulls in the app's AWS SDK
 * clients and Keychain secrets, which have no place in a CDK app.
 */

export const PARAM_PREFIX = "/codespace";

export type ImageVariant = "cpu-arm64" | "cpu-x86" | "gpu-arm64" | "gpu-x86";
export const IMAGE_VARIANTS: ImageVariant[] = ["cpu-arm64", "cpu-x86", "gpu-arm64", "gpu-x86"];

export const PARAMS = {
  subnetIds: `${PARAM_PREFIX}/network/subnet-ids`,
  securityGroupId: `${PARAM_PREFIX}/network/security-group-id`,
  instanceProfileArn: `${PARAM_PREFIX}/iam/instance-profile-arn`,
  launchTemplateId: (v: ImageVariant) => `${PARAM_PREFIX}/launch-template/${v}`,
  amiId: (v: ImageVariant) => `${PARAM_PREFIX}/ami/${v}`,
} as const;

export const TAG_APP = { Key: "app", Value: "codespace" } as const;

export type Arch = "x86_64" | "arm64";

export type VariantSpec = {
  arch: Arch;
  gpu: boolean;
  /** Public SSM parameter holding the latest parent AMI ID. Image Builder resolves it per build. */
  parentParam: string;
};

/**
 * Parent images.
 * - CPU: Canonical's Ubuntu 22.04 LTS (jammy) parameters. 22.04 is on EC2's hibernation-supported
 *   list; 24.04 isn't yet.
 * - GPU: "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)" and its ARM64 sibling.
 *   Paths taken from the DLAMI developer guide pages for each AMI.
 * All four parameters resolved in us-east-1, us-east-2 and us-west-2 on 2026-10-18.
 */
export const VARIANTS: Record<ImageVariant, VariantSpec> = {
  "cpu-x86": {
    arch: "x86_64",
    gpu: false,
    parentParam: "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
  },
  "cpu-arm64": {
    arch: "arm64",
    gpu: false,
    parentParam: "/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id",
  },
  "gpu-x86": {
    arch: "x86_64",
    gpu: true,
    parentParam: "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id",
  },
  "gpu-arm64": {
    arch: "arm64",
    gpu: true,
    parentParam: "/aws/service/deeplearning/ami/arm64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id",
  },
};

/**
 * Image Builder build instances. GPU images are built on CPU instances: the DLAMI already carries
 * the driver, setup.sh doesn't need a GPU, and new accounts have a G/P vCPU quota of 0. Image
 * Builder tries the types in order, so a type missing from the build subnet's AZ falls through.
 */
export const BUILD_INSTANCE_TYPES: Record<Arch, string[]> = {
  x86_64: ["m6i.xlarge", "m5.xlarge", "c5.xlarge"],
  arm64: ["m6g.xlarge", "c6g.xlarge", "m7g.xlarge"],
};
