# grogan.codes

A local app (Next.js + SQLite) that runs your coding work on EC2. Each workspace is one EC2 instance in your AWS account, running your own Claude Code, which you drive from a composer in the browser. The only things on your Mac are this app and its SQLite file in `.data/`.

## How it works

- The app launches one instance per workspace with the AWS SDK. Its encrypted gp3 root volume is the workspace disk, so files survive stops, hibernation and spot interruptions.
- Instances have no inbound ports. The app reaches them with SSH tunnelled through AWS Systems Manager (SSM) Session Manager: it runs `aws ssm start-session` and logs in as root with its own key in `.data/ssh/`.
- The network, launch templates and instance profile come from a CDK stack in [`infra/`](infra/README.md), deployed once in each region you use. The app reads the stack's SSM parameters under `/codespace/`.
- Region is a price choice, not a location one. Settings lists the regions workspaces may run in (default `us-east-1, us-east-2, us-west-2`, AWS's base-price US regions, which all offer every type at the same on-demand price). The first is the **home region**: AMIs are built there by EC2 Image Builder and copied to the others, and the IAM policy is created by its stack.

## Quick start

You need a Mac, an AWS account you can deploy to, and a Claude subscription.

```sh
brew install node pnpm awscli gh
brew install --cask session-manager-plugin
aws configure sso            # or `aws configure`; an admin profile for the one-time deploy
gh auth login                # optional, for the GitHub repo picker
git clone https://github.com/Grogan-Development/grogan.codes.git && cd grogan.codes
AWS_PROFILE=<admin-profile> pnpm run setup
pnpm start                   # http://localhost:4100
```

`pnpm run setup` ([scripts/setup.sh](scripts/setup.sh)) checks prerequisites, installs dependencies, bootstraps CDK and deploys [`infra/`](infra/README.md) to every region, starts the first image builds (20–40 minutes; Settings shows when they're ready), and builds the app. Set `CODESPACE_AWS_REGIONS` to change regions, or `SKIP_INFRA=1` if the stacks are already deployed. It's safe to re-run.

Then open Settings and enter your AWS profile and a Claude token from `claude setup-token`. Instead of Settings you can copy [`.env.example`](.env.example) to `.env.local`.

**It costs money:** workspaces are EC2 instances billed to your account. See the cost notes in [infra/README.md](infra/README.md#cost-notes), and consider `-c budgetEmail=you@example.com` on the deploy. The app has no login and only answers on `localhost`; see [SECURITY.md](SECURITY.md).

The sections below are the same steps by hand.

## Manual setup

1. Install the AWS CLI v2 and the Session Manager plugin on this Mac:

   ```sh
   brew install awscli
   brew install --cask session-manager-plugin
   ```

2. Set up an AWS profile, for example with `aws configure sso` (then `aws sso login`) or `aws configure`.
3. Deploy `infra/` in each region you want to use, home region first. [infra/README.md](infra/README.md) has the steps. The home region also builds the AMIs and copies them to the others, which takes a while.
4. For GPU workspaces, raise your vCPU quotas: AWS console → Service Quotas → Amazon EC2 → "Running On-Demand G and VT instances" (and "All G and VT Spot Instance Requests" for spot; "Running On-Demand P instances" for `p5`). New accounts start at 0, and increases aren't approved instantly.
5. Open the app. Settings asks for:
   - **AWS profile and regions**: an empty profile uses the default credential chain, and empty regions use the defaults. Settings shows the account it found, whether the infra stack and images are ready in each region, and whether `session-manager-plugin` is installed.
   - **Claude token**: run `claude setup-token` and paste the result.

Settings are stored in the macOS Keychain under the service `codespace` (the app's internal name). GitHub access comes from your local `gh auth token`.

## Workspaces

- Each workspace holds zero or more repos under `~/workspace` on its instance. When you create one you say what it needs (minimum vCPU and RAM, arm64 or x86_64, and optionally a GPU model and VRAM), and the picker lists the matching types, cheapest first for the chosen market, and selects the cheapest. Types range from Graviton and x86 CPU types to GPUs from a shared L4 up to an H100. Spot prices are live, from the cheapest ready region. Workspaces are Linux only.
- **Region** defaults to **Cheapest**, resolved when you create the workspace: for spot, the ready region with the lowest current spot price for the type; for on-demand, where prices are equal, the region with the best capacity. The picker shows where Cheapest would land and the price there. You can also pick a region by name; regions without the infra stack, without a built image, or that don't offer the type are greyed out with the reason. The workspace stays in its region for life.
- **Hibernate** saves memory to the disk and stops the instance, so running processes come back on start. Every CPU type supports it. GPU types can't hibernate, so for them Pause is a plain stop.
- **Stop** keeps the disk and ends running processes. A stopped instance costs only its disk (gp3, about $0.08 per GB-month).
- After the idle timeout the app stops the workspace. Activity means you using the app or a Claude turn running.
- There is no lifetime cap. A workspace runs until you stop it or it goes idle.
- **Market** is chosen per workspace:
  - **On-demand** costs full price, and the instance runs until you stop it.
  - **Spot** is usually much cheaper, but AWS can reclaim the instance with 2 minutes' notice. The disk is kept either way: CPU types hibernate and GPU types stop. The workspace shows as stopped with a note, and you start it again when capacity returns.
- **Cold storage**: a stopped instance still pays for its whole volume (about $0.08 per GB-month). After a workspace has been stopped for N days (Settings, default 3, 0 = never), or when you click **Archive now**, the app snapshots the disk and terminates the instance. A snapshot is billed only for data written (about $0.05 per GB-month), so a 50 GB disk with 12 GB used drops from about $4.00 to $0.60 a month. The workspace shows a **Cold** badge. Starting it restores: a new instance is built from the snapshot, which takes a few extra minutes. Files are kept; running processes and hibernated memory are not.
- Deleting a workspace terminates the instance and deletes its disk (and cancels the spot request), or deletes the snapshot of a cold one. Before that, and before removing a repo, the app checks for uncommitted, unpushed or stashed work.

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
  - New workspaces get every item. Trim a workspace's set in its Loadout panel, and save named presets.
  - A loadout is applied to the instance's `~/.claude` when a thread next starts.
- **Global instructions**: edited in Settings and written to `~/.claude/CLAUDE.md` in every workspace when a thread starts, above your personal CLAUDE.md. "Reset to default" brings back the built-in text.

## Checking the AWS integration

```sh
pnpm smoke
```

This launches a throwaway instance and runs it through Claude, the tunnels and the stop/start lifecycle, then terminates it. See `scripts/smoke.ts` for the exact checks.

Terminology lives in [GLOSSARY.md](GLOSSARY.md). The cut-over plan is in [docs/aws-cutover.md](docs/aws-cutover.md), and research notes are in [docs/research](docs/research).

## License

[MIT](LICENSE)
