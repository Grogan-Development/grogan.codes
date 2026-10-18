# Codespace workspace

You're running on a Codespace workspace: a cloud Linux VM that Zack drives from a browser composer, often without watching each step. He sees your messages, the diff, and the app's Ports, Terminal and Desktop panels. Each repo's own CLAUDE.md or AGENTS.md adds to this file and wins where the two conflict.

## The machine
- EC2, Ubuntu 22.04, and you are root. Repos live in `/root/workspace/<repo>`. `git` and `gh` are already signed in as Zack.
- Install whatever the task needs (apt, pip, npm, uv, cargo) without asking. Follow the repo's tooling (its lockfile, venv, package manager) over global installs, and list any system packages you added in your summary.
- The VM can be stopped, hibernated or spot-interrupted between turns. The disk survives, but running processes may not. If `/run/codespace/interruption` exists, the VM is about to be reclaimed: commit your work now.
- Start dev servers and watchers in the background with a log file (`nohup <cmd> > /tmp/<name>.log 2>&1 &`, or tmux) so they don't block your turn. Read the log to confirm the process started instead of assuming it did.
- On GPU types, `nvidia-smi` shows the GPU and driver. Check it before GPU work. If CUDA isn't usable, say so rather than quietly falling back to CPU.

## Ports
- Zack opens servers through the Ports panel, which tunnels to the VM. Bind to `127.0.0.1` or `0.0.0.0` on a fixed port you choose (pass `--host`/`--port` explicitly, never a random port), then tell him the port and path, for example "port 3000, `/settings`".
- Don't use ports 22, 5900, 6080 or 7681. The app uses them.
- Before you start a server, run `ss -ltnp` to see what's already listening. Reuse or restart your own servers, and don't kill processes you didn't start.

## Visual checks
- `chromium` is on PATH (Playwright's build, wrapped with `--no-sandbox`). `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` is set, so Playwright uses that build instead of downloading another.
- For UI changes, look at the result before reporting: `chromium --headless=new --screenshot=/tmp/shot.png --window-size=1280,800 <url>`, then read the PNG. Use a Playwright script for flows. Fix what you see.
- Zack's desktop (Xvfb plus XFCE on `DISPLAY=:0`) runs only while he has it open (`pgrep -x Xvfb`). Use it for headed runs he wants to watch, and never stop it. For headed runs otherwise, use `xvfb-run`.

## Before you change anything
- Read the repo's CLAUDE.md or AGENTS.md, its README, and the code you're about to touch.
- Run `git status`. Uncommitted changes you didn't make are Zack's work in progress. Don't stash, reset or overwrite them, and mention them in your reply.
- If you can't describe the diff in one sentence, make a brief plan (a todo list is fine), then carry it out. Don't stop to have the plan approved unless he asked for that.

## How to work
- Make the change yourself instead of suggesting it, and finish the whole task. Routine decisions (names, file placement, which existing pattern to follow) are yours to make. If the request has two plausible readings, pick the likelier one, name it in one sentence and continue.
- Stop and ask only for: product or design choices where different answers mean materially different work; destructive actions (deleting data, files or branches you didn't create, dropping tables, `git reset --hard`); and outward-facing actions (pushing to main or a shared branch, force-pushing, opening or merging PRs, deploying, sending messages, changing cloud or production resources).
- Match the surrounding code: its style, libraries, error handling and test layout. Don't add a dependency for something the repo already does.
- Keep the diff to the task. No drive-by refactors, reformatting, renames or speculative abstractions. Mention worthwhile follow-ups instead of doing them.
- Fix root causes. Don't skip, loosen or special-case tests, use `--no-verify`, or silence errors to get a pass. If a test itself looks wrong, say so.
- Batch independent reads and commands into one step. Hand work to subagents only when it's a large, independent track, such as a wide search across many files or separate packages. Do small things yourself.

## Git
- Never commit to main or master. If you're on the default branch, create a short topic branch (or follow the repo's naming) before your first commit.
- Commit at each working checkpoint with a clear message. Commits are cheap here, and lost work isn't.
- You can push your own feature branch. Ask before pushing to main or a shared branch, force-pushing, rewriting pushed history or merging.

## Secrets
- Never put secrets (API keys, tokens, passwords, private keys) in tracked files, commits, logs or your messages. Read them from environment variables or a gitignored `.env`, and add `.env` to `.gitignore` if it's missing.
- Before each commit, check `git diff --cached` for credentials.
- If a secret you need is missing, ask Zack to provide it as an environment variable. Don't hard-code a stand-in value.

## Done means verified
- Run the repo's own checks for what you changed: tests, typecheck, lint, build. For runnable changes, also run the thing: call the endpoint, load the page, run the CLI.
- If you couldn't verify something (there are no tests, it needs credentials, it needs hardware you don't have), say exactly what and why. Never report a check you didn't run.

## Final message
Lead with the outcome, keep it short, and use these headings:
- **Changed:** what changed, where, and on which branch or commit.
- **Verified:** the commands you ran and their results, plus screenshot paths for UI work.
- **Not done:** what's left, what you couldn't verify, risks, and decisions Zack needs to make.
- If anything is still running, give its port and URL path.

Don't recap every step or restate the task.
