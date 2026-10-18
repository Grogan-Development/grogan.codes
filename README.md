# Codespace

A local app (Next.js + SQLite) that runs your coding work in Modal sandboxes. Each sandbox runs your own Claude Code, which you drive from a composer in the browser. The only things on your Mac are this app and its SQLite file in `.data/`.

## Run

```sh
pnpm install
pnpm build && pnpm start        # http://localhost:4100
```

On first open, Settings asks for:

- **Modal token**: a token ID and secret from modal.com → Settings → API tokens. If you have run `modal setup`, the app uses `~/.modal.toml` and you can leave these empty.
- **Claude token**: run `claude setup-token` and paste the result.

Tokens you enter are stored in the macOS Keychain under the service `codespace`. GitHub access comes from your local `gh auth token`.

## What's in it

- **Workspaces**: each is one Modal sandbox (small, medium or large, optionally with 1–8 GPUs) holding zero or more repos under `~/workspace`.
  - Modal sandboxes can't pause. After the idle timeout the app snapshots the filesystem and stops the sandbox; the next start boots from that snapshot. Files are kept, running processes are not. Activity means you using the app or a Claude turn running.
  - Modal caps a sandbox at 24 hours, so the app also snapshots and stops a workspace 30 minutes before that.
  - Deleting a workspace or removing a repo first checks for uncommitted, unpushed or stashed work.
- **Composer**: the Claude Agent SDK runs here on the Mac and drives the unmodified `claude` CLI inside the sandbox (`src/server/transport.ts`). Features:
  - Threads: whole-workspace or pinned to one repo; resume and fork.
  - Streaming output, tool cards with diffs, and nested subagents.
  - Approval cards with "always allow", AskUserQuestion forms, and plan review.
  - Controls: permission mode, model, interrupt, and queue or steer while Claude is working.
  - Slash command autocomplete, pasting images, and a todo list and background-task tray.
  - Context and usage meters.
- **Panels**: Terminal (ttyd), Browser (VNC desktop with Chromium, started on demand), Diff, Loadout, and Ports (preview links gated by a Modal connect token).
- **Loadouts**: a catalog imported from `~/.claude` (plugins, skills, agents, commands, workflows, CLAUDE.md) plus MCP servers you add.
  - Pick a set per workspace and save named presets.
  - A loadout is applied to the sandbox's `~/.claude` when a thread next starts.

## Checking the Modal integration

```sh
pnpm smoke
```

This boots a throwaway sandbox, runs one Claude turn through the remote transport, checks the terminal and VNC behind connect tokens, then snapshots, terminates and restores it. `SMOKE_GPU=T4 pnpm smoke` also checks a GPU snapshot.

Terminology lives in [GLOSSARY.md](GLOSSARY.md). Research notes are in [docs/research](docs/research).
