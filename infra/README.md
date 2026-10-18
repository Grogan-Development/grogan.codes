# Codespace infra (AWS CDK)

One regional stack, `CodespaceStack`, that the app needs before it can launch workspaces. It
publishes SSM parameters under `/codespace/` (names in `src/server/aws/config.ts` → `PARAMS`, copied
in `lib/names.ts`). The app reads those and creates the per-workspace instances itself.

| What | Where the app finds it |
|---|---|
| VPC with one public subnet per AZ (up to 6), no NAT, public IPv4 on launch, free S3 gateway endpoint | `/codespace/network/subnet-ids` (StringList) |
| Security group with no inbound rules, all outbound | `/codespace/network/security-group-id` |
| Instance role (`AmazonSSMManagedInstanceCore`) + instance profile, path `/codespace/` | `/codespace/iam/instance-profile-arn` |
| Image Builder pipeline per variant (`cpu-arm64`, `cpu-x86`, `gpu-arm64`, `gpu-x86`) running `image/setup.sh` | AMI ID in `/codespace/ami/<variant>` |
| Launch template per variant: AMI `resolve:ssm:/codespace/ami/<variant>`, IMDSv2 (hop limit 2), gp3 encrypted root, SG, profile, `app=codespace` tags | `/codespace/launch-template/<variant>` |
| EBS encryption by default for the account and region | (account setting) |
| Managed policy `CodespaceApp` (optionally IAM user `codespace-app`) | attach it to whoever runs the app |
| Monthly cost budget email (optional) | |

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
- **CDK bootstrap**, once per account and region:
  ```sh
  pnpm exec cdk bootstrap aws://<account>/<region>
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
pnpm exec cdk diff  -c region=us-east-1
pnpm exec cdk deploy -c region=us-east-1
```

Context flags (`-c key=value`):

| Flag | Default | Meaning |
|---|---|---|
| `region` | `CDK_DEFAULT_REGION`, else `us-east-1` | Target region |
| `account` | from your credentials | Target account |
| `azs` | every AZ (looked up, max 6) | Comma-separated AZ names. Skips the lookup. |
| `iam` | `true` | Create the account-global `CodespaceApp` policy. Pass `false` when deploying a second region: the policy is region-agnostic and already exists. |
| `policyName` | `CodespaceApp` | Managed policy name |
| `appUser` | `false` | Also create IAM user `codespace-app` with the policy. Access keys are never created by CDK. |
| `ebsEncryption` | `true` | Turn on EBS encryption by default for the account+region. It stays on if the stack is deleted, and it affects every new volume in that region, not just Codespace's. |
| `imageSchedule` | `manual` | `weekly` rebuilds every Monday 09:00 UTC |
| `budgetEmail` / `budgetUsd` | off / `100` | Account-wide monthly cost budget, alerting at 80% actual and 100% forecast. Budgets are global, so set it in one region only. |

The first deploy looks up the region's AZs and caches them in `cdk.context.json`. Commit that file.

To synthesize offline (no credentials):

```sh
pnpm exec cdk synth -c account=111111111111 -c region=us-east-1 -c azs=us-east-1a,us-east-1b,us-east-1c
```

### First run: build the images

Each launch template resolves its AMI from `/codespace/ami/<variant>`. Before the first image build, that parameter holds the **parent** AMI: plain Ubuntu, or the DLAMI. A custom resource seeds it so the stack can deploy. Workspaces launched from the parent AMI have no ttyd, desktop or sshd config, so **run every pipeline once after the first deploy**:

```sh
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

When a build finishes, the distribution step writes the new AMI ID to `/codespace/ami/<variant>`, and new launches pick it up. Existing workspaces keep their disks. Run the pipelines again, or set `imageSchedule=weekly`, to pick up OS and tool updates.

Notes:

- **Redeploys:** a redeploy never resets an AMI parameter that a build already wrote.
- **Distribution role:** Image Builder writes the parameter with the pipeline's execution role (`EC2ImageBuilderExecutionPolicy` + `ssm:PutParameter` on `/codespace/ami/*`). The service-linked role may only write under `/imagebuilder/`.
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
- **SSM parameters:** read `/codespace/*` and `/aws/service/*`.
- **Sessions:**
  - `ssm:StartSession` on instances tagged `app=codespace` and the `AWS-StartSSHSession` document
  - terminate, resume and open-data-channel on the caller's own sessions only

## Cost notes

- **No NAT gateway:** instances use public IPv4 addresses directly. AWS charges about $0.005/hour, roughly **$3.60/month**, for each public IPv4 while an instance is running. A stopped or hibernated instance has no public IP and pays nothing for it.
- **EBS** is billed while instances are stopped or hibernated. That's the price of keeping the disk: gp3 is about $0.08/GB-month in us-east-1, so a 50 GB workspace costs about $4/month at rest. Hibernated instances also keep their RAM image on that volume, which is why the app sizes the root volume as disk + RAM.
- **AMIs:**
  - Each build keeps an AMI and its snapshot, about $0.05/GB-month.
  - The CPU images are 16 GB; the DLAMI-based images are larger.
  - Deregister old `codespace-*` AMIs, and delete their snapshots, now and then, especially with weekly builds.
- **Image builds:** each runs one xlarge build instance for its duration, cents per build.
- **Always free here:** the VPC, subnets, security group, S3 gateway endpoint, SSM parameters (standard tier), launch templates, and Image Builder itself.
- **Custom resources:** the two Lambda-backed ones run only during deploys.
