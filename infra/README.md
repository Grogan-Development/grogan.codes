# Codespace infra (AWS CDK)

One `CodespaceStack` per region, named `Codespace-<region>`, holding what the app needs before it can
launch workspaces there. Each stack publishes SSM parameters under `/codespace/` in its own region
(names in `src/server/aws/config.ts` → `PARAMS`, copied in `lib/names.ts`). The app reads those and
creates the per-workspace instances itself.

The regions come from context `regions` (default `us-east-1,us-east-2,us-west-2`). The first one is
the **home region**. Only the home stack has:

- the Image Builder pipelines, whose distributions copy every AMI to all regions and write `/codespace/ami/<variant>` in each
- the account-global `CodespaceApp` policy, the optional IAM user, and the optional budget

Every stack has its own VPC, security group, instance profile, launch templates, network parameters and AMI-parameter seeding.

| What | Where the app finds it |
|---|---|
| VPC with one public subnet per AZ (up to 6), no NAT, public IPv4 on launch, free S3 gateway endpoint | `/codespace/network/subnet-ids` (StringList) |
| Security group with no inbound rules, all outbound | `/codespace/network/security-group-id` |
| Instance role (`AmazonSSMManagedInstanceCore`) + instance profile, path `/codespace/` | `/codespace/iam/instance-profile-arn` |
| Image Builder pipeline per variant (`cpu-arm64`, `cpu-x86`, `gpu-arm64`, `gpu-x86`) running `image/setup.sh`, home region only | AMI ID in `/codespace/ami/<variant>` in every region |
| Launch template per variant: AMI `resolve:ssm:/codespace/ami/<variant>`, IMDSv2 (hop limit 2), gp3 encrypted root, SG, profile, `app=codespace` tags | `/codespace/launch-template/<variant>` |
| EBS encryption by default for the account and region | (account setting) |
| Managed policy `CodespaceApp` (optionally IAM user `codespace-app`), home stack only | attach it to whoever runs the app |
| Monthly cost budget email (optional), home stack only | |

Parent images:

- **CPU:** Ubuntu 22.04 LTS from Canonical's public parameter. It's on EC2's hibernation-supported list, and 24.04 isn't.
- **GPU:** AWS Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04), from `/aws/service/deeplearning/ami/{x86_64,arm64}/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id`.

GPU images are built on CPU instances, because the driver is already in the DLAMI.

## Prerequisites

- Node 22+ and pnpm. Install deps inside `infra/`. This folder has its own `pnpm-workspace.yaml` and lockfile, separate from the app:
  ```sh
  cd infra && pnpm install
  ```
- AWS CLI v2 with admin-ish credentials for the deploy, e.g. `aws sso login --profile <admin>`.
- **CDK bootstrap**, once per account and region, for every region in `regions`:
  ```sh
  pnpm exec cdk bootstrap aws://600402507537/us-east-1 aws://600402507537/us-east-2 aws://600402507537/us-west-2
  ```
- **On the Mac that runs the app:** AWS CLI v2 and the Session Manager plugin. All SSH goes through `aws ssm start-session`.
  ```sh
  brew install awscli
  brew install --cask session-manager-plugin
  ```
- **GPU quotas:** new accounts have 0 vCPUs for G and P instances, both on-demand and spot. Raise these in Service Quotas → Amazon EC2 in each region you use:
  - "Running On-Demand G and VT instances"
  - "All G and VT Spot Instance Requests"
  - the P equivalents if you want them

  Until then, GPU launches fail with `VcpuLimitExceeded`.

## Deploy

```sh
cd infra
export AWS_PROFILE=<admin>
pnpm exec cdk diff --all -c account=600402507537
pnpm exec cdk deploy --all -c account=600402507537
```

That deploys `Codespace-us-east-1` (home), `Codespace-us-east-2` and `Codespace-us-west-2`. The
stacks don't depend on each other. The home stack's distributions write parameters in the other
regions, but only when a pipeline runs, and that happens by hand after the deploy.

To deploy just one region, name its stack: `pnpm exec cdk deploy Codespace-us-west-2 -c account=...`.

Context flags (`-c key=value`):

| Flag | Default | Meaning |
|---|---|---|
| `regions` | `us-east-1,us-east-2,us-west-2` | Regions to deploy, home first. Keep in step with the app's `aws-regions` setting. After adding a region, redeploy the home stack too, so its distributions include the new region. |
| `account` | `CDK_DEFAULT_ACCOUNT` (from your credentials) | Target account |
| `azs.<region>` | every AZ (looked up, max 6) | Comma-separated AZ names for that region. Skips the lookup. |
| `policyName` | `CodespaceApp` | Managed policy name (home stack) |
| `appUser` | `false` | Also create IAM user `codespace-app` with the policy (home stack). Access keys are never created by CDK. |
| `ebsEncryption` | `true` | Turn on EBS encryption by default in each deployed region. It stays on if a stack is deleted, and it affects every new volume in that region, not just Codespace's. |
| `imageSchedule` | `manual` | `weekly` rebuilds every Monday 09:00 UTC |
| `budgetEmail` / `budgetUsd` | off / `100` | Account-wide monthly cost budget (home stack), alerting at 80% actual and 100% forecast |

The first synth looks up each region's AZs (read-only) and caches them in `cdk.context.json`. Commit that file.

To synthesize without credentials, give AZs for every region and a dummy account:

```sh
pnpm exec cdk synth -c account=111111111111 \
  -c azs.us-east-1=us-east-1a,us-east-1b -c azs.us-east-2=us-east-2a,us-east-2b -c azs.us-west-2=us-west-2a,us-west-2b
```

### First run: build the images

Each launch template resolves its AMI from `/codespace/ami/<variant>`. Before the first image build, that parameter holds the **parent** AMI: plain Ubuntu, or the DLAMI. A custom resource in each regional stack seeds it with that region's parent AMI, so the stack can deploy. Workspaces launched from the parent AMI have no ttyd, desktop or sshd config, so **after deploying every stack, run the four pipelines once in the home region**. Each build is copied to all regions:

```sh
export AWS_REGION=us-east-1   # home
for v in cpu-arm64 cpu-x86 gpu-arm64 gpu-x86; do
  arn=$(aws imagebuilder list-image-pipelines --filters name=name,values=codespace-$v \
        --query 'imagePipelineList[0].arn' --output text)
  aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$arn"
done
```

Each build takes about 20 to 40 minutes. Watch them in the Image Builder console, or with:

```sh
aws imagebuilder list-image-pipeline-images --image-pipeline-arn "$arn" \
  --query 'imageSummaryList[].{v:version,state:state.status}'
aws ssm get-parameter --name /codespace/ami/cpu-arm64 --query Parameter.Value --output text
```

When a build finishes, the distribution step copies the AMI to every region in `regions` and writes its ID to `/codespace/ami/<variant>` in each. New launches pick it up. Check another region with `aws ssm get-parameter --region us-west-2 --name /codespace/ami/cpu-arm64`. Existing workspaces keep their disks. Run the pipelines again, or set `imageSchedule=weekly`, to pick up OS and tool updates.

Notes:

- **Redeploys:** a redeploy never resets an AMI parameter that a build already wrote.
- **Distribution role:** Image Builder copies and writes with the pipeline's execution role: `EC2ImageBuilderExecutionPolicy` (which includes `ec2:CopyImage` and EBS KMS use via EC2) + `ssm:GetParameter`/`PutParameter` on `/codespace/ami/*` in each target region. The service-linked role may only write under `/imagebuilder/`.
- **Regional seeding:** if a pipeline runs before a region's stack exists, Image Builder creates that region's parameter itself, and the stack's seeding later leaves it alone. Running the pipelines after all stacks are deployed is still the simple order.
- **Build logs:** in CloudWatch under `/aws/imagebuilder/codespace-<variant>-*`.
- **Build subnet:** builds run in the first public subnet (the first AZ). If no build instance type in `lib/names.ts` is offered there, change the list.
- **`setup.sh` by hand:** it also runs on a fresh Ubuntu 22.04 instance, which is handy for debugging:
  ```sh
  sudo CODESPACE_VARIANT=cpu-arm64 bash setup.sh
  ```

## Credentials for the app

The app resolves credentials through the standard chain, using the profile and region set in its Settings or `AWS_PROFILE`/`AWS_REGION`. It needs the `CodespaceApp` policy.

**Option A: SSO profile (recommended).**
1. In IAM Identity Center, create a permission set with the customer managed policy `CodespaceApp`. The policy must exist in each account the permission set is assigned to.
2. Assign the permission set to yourself, then:
   ```sh
   aws configure sso --profile codespace
   aws sso login --profile codespace
   ```
3. Enter `codespace` as the profile in the app's Settings.

Sessions expire, so run `aws sso login` again when the app reports an expired token.

**Option B: IAM user.**
1. Deploy with `-c appUser=true`.
2. Create a key by hand. Keys are never created in CDK, to keep them out of CloudFormation:
   ```sh
   aws iam create-access-key --user-name codespace-app
   aws configure --profile codespace   # paste the key
   ```
3. Enter `codespace` as the profile in Settings.

Rotate the key periodically.

What the policy allows, all region-agnostic:

- **EC2 read:**
  - `Describe*`
  - spot placement scores and price history
- **Launching:**
  - `RunInstances` only when the instance, volume and spot request carry `app=codespace`, and only into subnets, security groups and launch templates tagged `app=codespace`
  - `CreateTags` only as part of `RunInstances`
- **Lifecycle** (start, stop, terminate, modify, cancel spot) only on resources tagged `app=codespace`.
- **`iam:PassRole`** only on roles under `/codespace/`, and only to EC2.
- **`iam:CreateServiceLinkedRole`** only for `AWSServiceRoleForEC2Spot` (`spot.amazonaws.com`). The first spot launch in an account that has never used spot creates that role, and fails with `AuthFailure.ServiceLinkedRoleCreationNotPermitted` without this permission.
- **SSM parameters:** read `/codespace/*` and `/aws/service/*`.
- **Sessions:**
  - `ssm:StartSession` on instances tagged `app=codespace` and the `AWS-StartSSHSession` document
  - terminate, resume and open-data-channel on the caller's own sessions only

## Cost notes

- **No NAT gateway:** instances use public IPv4 addresses directly. AWS charges about $0.005/hour, roughly **$3.60/month**, for each public IPv4 while an instance is running. A stopped or hibernated instance has no public IP and pays nothing for it.
- **EBS** is billed while instances are stopped or hibernated. That's the price of keeping the disk: gp3 is about $0.08/GB-month in us-east-1, so a 50 GB workspace costs about $4/month at rest. Hibernated instances also keep their RAM image on that volume, which is why the app sizes the root volume as disk + RAM.
- **AMIs:**
  - Each build keeps an AMI and its snapshot in **every** region it's copied to, about $0.05/GB-month per copy.
  - The CPU images are 16 GB; the DLAMI-based images are larger.
  - Deregister old `codespace-*` AMIs, and delete their snapshots, now and then, especially with weekly builds.
- **Image builds:** each runs one xlarge build instance for its duration, cents per build.
- **Always free here:** the VPC, subnets, security group, S3 gateway endpoint, SSM parameters (standard tier), launch templates, and Image Builder itself.
- **Custom resources:** the two Lambda-backed ones run only during deploys.
