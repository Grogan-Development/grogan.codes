# AWS cut-over plan (Modal → EC2)

Branch `aws`. Codespace moves from Modal sandboxes to one EC2 instance per workspace. Modal is removed entirely.

## Decisions

- **One EC2 instance per workspace.** Its encrypted gp3 root EBS volume *is* the workspace disk. There are no filesystem snapshots, and there is no 24h lifetime cap.
- **Pause** hibernates (keeps RAM) when the instance was launched with hibernation. That applies to every CPU type in `machines.ts`. **Stop** is a plain stop. GPU types can't hibernate, so for them both actions are a plain stop. Either way, files survive.
- **Market per workspace**: `on-demand` or `spot`.
  - Spot uses a *persistent* request with interruption behaviour `hibernate` (CPU) or `stop` (GPU). An interruption then behaves like a forced pause, and the disk survives.
  - Deleting a spot workspace must cancel its spot request as well as terminate the instance.
- **Reaching instances: SSH over AWS SSM Session Manager.**
  - The Mac spawns `aws ssm start-session --target <id> --document-name AWS-StartSSHSession --parameters portNumber=22` and uses its stdio as the socket for the `ssh2` npm client.
  - The client logs in as `root` with the app's ed25519 key (`src/server/aws/keys.ts`, which writes `.data/ssh/id_ed25519`).
  - The security group has **no inbound rules**, and sshd listens on 127.0.0.1 only.
  - The Mac needs the AWS CLI v2 and `session-manager-plugin`.
- **Ports** (Terminal/ttyd 7681, VNC/websockify 6080, previews) are reached through ssh2 `forwardOut`, behind a local listener on `127.0.0.1:<port>`. Preview, terminal and desktop URLs become `http://127.0.0.1:<port>/...` / `ws://127.0.0.1:<port>/websockify`. Modal connect tokens go away.
- **Infra as code: AWS CDK (TypeScript) in `infra/`**, with EC2 Image Builder for AMIs. The stack is regional. It publishes SSM parameters that the app reads (names in `src/server/aws/config.ts` → `PARAMS`).
- **Per-workspace instances are created by the app at runtime** with `@aws-sdk/client-ec2`, never through IaC.
- **Region** comes from Settings (default `us-east-1`). Each workspace records its region and availability zone. Spot launches choose an availability zone with `GetSpotPlacementScores` (SingleAvailabilityZone) and try the next zone on capacity errors.

## Contract files (already written; don't change signatures without saying so in your report)

| File | What it gives you |
|---|---|
| `src/server/aws/config.ts` | `awsRegion()`, `awsProfile()`, `clientConfig()`, `resetAws()`/`awsGeneration()` (rebuild cached clients when the generation changes), `checkAwsCredentials()`, `PARAMS`, `ImageVariant`, `TAG_APP`, `TAG_WORKSPACE` |
| `src/server/aws/machines.ts` | `MACHINES`, `Machine`, `Market`, `MARKETS`, `machine(type)`, `machineLabel(m)`, `DEFAULT_MACHINE`, `DISK_GB_STEPS`, `DEFAULT_DISK_GB` |
| `src/server/aws/keys.ts` | `sshPublicKey()`, `sshPrivateKey()` |
| `src/server/remote.ts` | `HOME`, `WORKSPACE_ROOT`, `TERMINAL_PORT`, `VNC_PORT`, `PATH_PREFIX`, `q`, `Remote`, `RemoteProcess`, `ExecOptions`, `remote()`, `waitForRemote()`, `forgetRemote()`, `run()`, `mustRun()`, `forwardPort()` (stubs, implemented by the SSH work) |
| `src/server/secrets.ts` | secret names are now `aws-profile`, `aws-region` and `claude-oauth-token` |

## Server contract: `src/server/aws/ec2.ts` and `src/server/workspaces.ts`

`ec2.ts` exports, besides whatever it needs internally:
- `spotPrices(types: string[]): Promise<Record<string, number>>`: the lowest current spot price per type across the region's AZs, cached for about 5 minutes.
- `infraStatus(): Promise<{ ok: boolean; missing: string[] }>`: whether the CDK stack's SSM parameters exist in the current region.

`workspaces.ts` keeps its exported names: `listWorkspaces`, `getWorkspace`, `listRepos`, `createWorkspace`, `retrySetup`, `bootstrap`, `addRepo`, `unsavedWork`, `removeRepo`, `lifecycle`, `deleteWorkspace`, `setIdleMinutes`, `syncState`, `ensureStarted`, `touch`, `previewUrl`, `terminalUrl`, `startDesktop`, `stopDesktop`, `diff`, `SETUP_FAILED`, `parseRepo`. Also:
- `ensureStarted(id)` and the renamed `workspaceRemote(id)` (was `workspaceSandbox`) return `Promise<Remote>`.
- `createWorkspace({ name, instanceType, market, diskGb, idleMinutes, repos, loadout })`.

DB columns on `workspaces`:
- **New:** `instance_id`, `instance_type`, `market`, `region`, `az`, `hibernate` (0/1, whether it was launched with hibernation), `instance_started_at`.
- **Kept:** `disk_gb`, which is now the real root volume size, and `disk_used_mb`.
- **Legacy:** `sandbox_id`, `image_id`, `cpu`, `memory_mib` and `gpu` are no longer read. `snapshot` is NOT NULL, so write the instance type into it.
- **Modal-era rows** (no `instance_type`) get state `error` with the message "Created on Modal, which this version no longer supports. Delete it."

States: `creating`, `setting up`, `starting`, `started`, `stopping`, `stopped`, `error`, `setup failed`. (`snapshotting` is gone.) A spot interruption leaves state `stopped`, with `error` explaining that AWS reclaimed the capacity and files were kept.

Workspace JSON returned by the API: the DB row (minus legacy columns) plus `machine: Machine`, plus the existing `repos`/`activity`/`threads`.

`POST /api/workspaces` body: `{ name, instanceType, market, diskGb, idleMinutes, repos, loadout }`.

`GET /api/machines` returns `{ machines: Machine[], defaultType, diskSteps, defaultDiskGb, region, spot: Record<type, number> }`. The `spot` field is best-effort: `{}` if the lookup fails.

`GET /api/settings` returns `{ aws: AwsStatus & { infra: { ok, missing } }, claude: boolean, github: boolean, ssmPlugin: boolean }`. `POST` takes `{ awsProfile?, awsRegion?, claudeToken? }` and calls `resetAws()` when AWS settings change.

Preview, terminal and desktop routes keep their response shapes (`{ url }`). Only the URL form changes.

## IAM actions the app needs (the `infra/` stack creates a managed policy with these)

- `sts:GetCallerIdentity`
- **EC2:**
  - `ec2:Describe*`, `ec2:GetSpotPlacementScores`, `ec2:DescribeSpotPriceHistory`
  - `ec2:RunInstances` + `ec2:CreateTags` on create, conditioned on request tag `app=codespace` where the resource supports it
  - `ec2:StartInstances`, `ec2:StopInstances`, `ec2:TerminateInstances`, `ec2:ModifyInstanceAttribute`, `ec2:CancelSpotInstanceRequests`, conditioned on resource tag `app=codespace`
- `iam:PassRole` on the instance role
- **SSM:**
  - `ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath` on `/codespace/*` and `/aws/service/*`
  - `ssm:StartSession` on instances tagged `app=codespace` and on document `AWS-StartSSHSession`
  - `ssm:TerminateSession`, `ssm:ResumeSession` on the caller's own sessions

## Image contents (AMI built by Image Builder from `infra/image/setup.sh`)

- **Base OS:**
  - **CPU variants:** Ubuntu 22.04 LTS. It's on AWS's hibernation-supported list; 24.04 is not yet. Disable KASLR as AWS recommends for hibernation.
  - **GPU variants:** the AWS Deep Learning Base OSS NVIDIA Driver AMI (Ubuntu 22.04), for x86_64 and arm64.
- **sshd:**
  - `ListenAddress 127.0.0.1`
  - `PermitRootLogin prohibit-password`, `PasswordAuthentication no`
  - `AcceptEnv CLAUDE_* CS_* MCP_* DISABLE_* ANTHROPIC_*`
- **Boot behaviour:**
  - amazon-ssm-agent enabled, and ec2-hibinit-agent present.
  - Cloud-init user-data (written by the app at launch) appends the app's public key to `/root/.ssh/authorized_keys`.
- **Tools:**
  - Node LTS in `/usr/local/bin`, git, `gh`, ttyd 1.7.7
  - Claude Code installed for root (`/root/.local/bin/claude`)
  - ripgrep, python3, build-essential, tmux, jq, curl
- **Desktop:**
  - Xvfb, xfce4, x11vnc, novnc + websockify, at the paths `workspaces.ts` uses: `websockify --web /usr/share/novnc`, `startxfce4`.
  - A non-snap Chromium or Chrome.
- **Spot watcher:** a small systemd service that polls IMDSv2 `spot/instance-action` and writes `/run/codespace/interruption` when a notice arrives.

## Ownership (agents work in parallel in this worktree; touch only your files)

| Agent | Owns |
|---|---|
| infra | `infra/**` (standalone CDK app with its own package.json and lockfile; install with `pnpm install --ignore-workspace` inside `infra/`) |
| ec2 | `src/server/aws/ec2.ts`, `src/server/workspaces.ts`, `src/server/db.ts`, `src/app/api/workspaces/**`, `scripts/smoke.ts` |
| ssh | `src/server/remote.ts` (implement), `src/server/transport.ts`, `src/server/catalog.ts`, `src/server/threads.ts`, `next.config.ts` |
| ui | `src/components/**`, `src/lib/api.ts`, `src/app/api/settings/route.ts`, `src/app/api/machines/route.ts`, `src/app/desktop/**`, `README.md`, `GLOSSARY.md` |

Nobody commits. The integrator deletes `src/server/modal.ts`, removes the `modal` dependency, and runs typecheck, lint and build across the whole tree. Until then, errors in files you don't own are expected. Make your own files correct against the contract.
