# grogan.codes

A local app (Next.js + SQLite) that runs your coding work on EC2. Each workspace is one EC2 instance in your AWS account, running your own Claude Code, which you drive from a composer in the browser. The only things on your Mac are this app and its SQLite file in `.data/`.

## How it works

- The app launches one instance per workspace with the AWS SDK. Its encrypted gp3 root volume is the workspace disk, so files survive stops, hibernation and spot interruptions.
- Instances have no inbound ports. The app reaches them with SSH tunnelled through AWS Systems Manager (SSM) Session Manager: it runs `aws ssm start-session` and logs in as root with its own key in `.data/ssh/`.
- The network, IAM role, launch templates and AMIs come from a CDK stack in [`infra/`](infra/README.md), deployed once per region. The app reads the stack's SSM parameters under `/codespace/`.

## Run

```sh
pnpm install
pnpm build && pnpm start        # http://localhost:4100
```

## First-time setup

1. Install the AWS CLI v2 and the Session Manager plugin on this Mac:

   ```sh
   brew install awscli
   brew install --cask session-manager-plugin
   ```

2. Set up an AWS profile, for example with `aws configure sso` (then `aws sso login`) or `aws configure`.
3. Deploy `infra/` in the region you want to use. [infra/README.md](infra/README.md) has the steps. The first deploy also builds the AMIs, which takes a while.
4. For GPU workspaces, raise your vCPU quotas: AWS console → Service Quotas → Amazon EC2 → "Running On-Demand G and VT instances" (and "All G and VT Spot Instance Requests" for spot; "Running On-Demand P instances" for `p5`). New accounts start at 0, and increases aren't approved instantly.
5. Open the app. Settings asks for:
   - **AWS profile and region**: an empty profile uses the default credential chain. Settings shows the account it found, whether the infra stack is deployed in that region, and whether `session-manager-plugin` is installed.
   - **Claude token**: run `claude setup-token` and paste the result.

Settings are stored in the macOS Keychain under the service `codespace` (the app's internal name). GitHub access comes from your local `gh auth token`.

## Workspaces

- Each workspace holds zero or more repos under `~/workspace` on its instance. You pick the instance type when you create it: Graviton (arm64) or x86 CPU types, or a GPU type, from fractions of an L4 up to an H100. The picker shows the on-demand price and, when AWS returns it, the live spot price.
- **Hibernate** saves memory to the disk and stops the instance, so running processes come back on start. Every CPU type supports it. GPU types can't hibernate, so for them Pause is a plain stop.
- **Stop** keeps the disk and ends running processes. A stopped instance costs only its disk (gp3, about $0.08 per GB-month).
- After the idle timeout the app stops the workspace. Activity means you using the app or a Claude turn running.
- There is no lifetime cap. A workspace runs until you stop it or it goes idle.
- **Market** is chosen per workspace:
  - **On-demand** costs full price, and the instance runs until you stop it.
  - **Spot** is usually much cheaper, but AWS can reclaim the instance with 2 minutes' notice. The disk is kept either way: CPU types hibernate and GPU types stop. The workspace shows as stopped with a note, and you start it again when capacity returns.
- Deleting a workspace terminates the instance and deletes its disk (and cancels the spot request). Before that, and before removing a repo, the app checks for uncommitted, unpushed or stashed work.

## What's in it

- **Composer**: the Claude Agent SDK runs here on the Mac and drives the unmodified `claude` CLI on the instance over SSH (`src/server/transport.ts`). Features:
  - Threads: whole-workspace or pinned to one repo; resume and fork.
  - Streaming output, tool cards with diffs, and nested subagents.
  - Approval cards with "always allow", AskUserQuestion forms, and plan review.
  - Controls: permission mode, model, interrupt, and queue or steer while Claude is working.
  - Slash command autocomplete, pasting images, and a todo list and background-task tray.
  - Context and usage meters.
- **Panels**: Terminal (ttyd), Browser (VNC desktop with Chromium, started on demand), Diff, Loadout, and Ports. Terminal, desktop and port previews are forwarded over the SSH connection to local ports, so their links look like `http://127.0.0.1:<port>/` and only work on this Mac.
- **Loadouts**: a catalog imported from `~/.claude` (plugins, skills, agents, commands, workflows, CLAUDE.md) plus MCP servers you add.
  - Pick a set per workspace and save named presets.
  - A loadout is applied to the instance's `~/.claude` when a thread next starts.

## Checking the AWS integration

```sh
pnpm smoke
```

This launches a throwaway instance and runs it through Claude, the tunnels and the stop/start lifecycle, then terminates it. See `scripts/smoke.ts` for the exact checks.

Terminology lives in [GLOSSARY.md](GLOSSARY.md). The cut-over plan is in [docs/aws-cutover.md](docs/aws-cutover.md), and research notes are in [docs/research](docs/research).
