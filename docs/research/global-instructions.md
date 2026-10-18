# Default global instructions: research notes

Researched 2026-10-18 for `src/server/default-instructions.md`, the text `catalog.ts` writes to `~/.claude/CLAUDE.md` in every workspace. If Zack imports his own CLAUDE.md, it's appended after this text under `# Personal instructions`. Project CLAUDE.md or AGENTS.md files load after both.

## Sources

**Anthropic**
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (the old `claude-4-best-practices` URL redirects here). It covers all current models, including Opus 5.5.
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) (formerly anthropic.com/engineering/claude-code-best-practices)
- [How Claude remembers your project (CLAUDE.md and memory)](https://code.claude.com/docs/en/memory)

**Community and research**
- HumanLayer, [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md). It cites [arXiv 2507.11538](https://arxiv.org/abs/2507.11538) on how many instructions a model can follow at once.
- Gloaguen et al., [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/abs/2602.11988) (ICLR 2026)
- Survey write-ups that converge on the same points: [understandingdata.com](https://understandingdata.com/posts/writing-a-good-claude-md), [aiengineerguide notes](https://aiengineerguide.com/til/notes-on-writing-a-good-claude-md/)

## Key findings

1. **Length costs adherence.**
   - The memory docs say to target under 200 lines per file, because longer files "consume more context and reduce adherence".
   - The best-practices guide says bloated files make Claude ignore the instructions that matter. Its test for every line: "Would removing this cause Claude to make mistakes?"
   - HumanLayer reports that frontier models follow roughly 150–200 instructions reliably. Claude Code's own system prompt uses about 50 of those, and adherence drops across the board as the count grows. HumanLayer's root file is under 60 lines.
   - This file shares the budget with Zack's personal file and every project file, so it targets about 55 lines.
2. **Context files raise cost, not success, unless they say something non-standard.**
   - Gloaguen et al. found that context files didn't improve task success and raised inference cost by more than 20%.
   - Agents did follow the instructions, but repository overviews didn't help.
   - Their conclusion: use these files for non-standard practices.
   - The implication: drop generic coding advice and keep what's specific to this environment and this developer.
3. **Include what Claude can't infer, and exclude what it already does.**
   - The best-practices guide has an include/exclude table. Include environment quirks, commands Claude can't guess, repository etiquette and gotchas. Exclude "write clean code"-style platitudes, standard conventions and tutorials.
4. **Current models follow instructions literally and respond to normal phrasing.**
   - If you ask for suggestions, you get suggestions. To get action by default, say so; the docs offer a `default_to_action` prompt.
   - Aggressive wording ("CRITICAL: You MUST") now causes over-triggering, so plain imperatives work better.
   - Use emphasis on at most one line. If many lines are emphasized, none stands out.
5. **Explain why.** Rules that come with a reason generalize better than bare "NEVER" lines (Prompting best practices, "Add context"). That's why the ports and commit lines give their reasons.
6. **Opus 5 and later already verify and self-correct, and generic "double-check" lines make it worse.**
   - The Opus 5 guide says to remove instructions like "include a final verification step" or "use a subagent to verify", because they cause over-verification.
   - The best-practices guide still says the biggest lever is giving Claude a concrete check it can run, and having it show evidence instead of asserting success.
   - So the file defines what counts as verified in this environment (the repo's checks plus actually running the change) and requires honest reporting. It doesn't say "double-check".
7. **Opus 5 can widen scope and delegates readily.**
   - The guides offer two sample prompts: a scope prompt ("Deliver what was asked… say so in a sentence and continue") and a delegation damper ("only for large tasks that are genuinely independent").
   - The Overeagerness section adds: no extra features, no drive-by refactors, no abstractions for one-off operations.
8. **Make risky actions depend on reversibility.**
   - The "Balancing autonomy and safety" sample allows local, reversible actions freely.
   - It asks first for destructive actions, actions that are hard to reverse, and anything visible to others, and gives examples: force-push, `reset --hard`, pushing, PR comments, `--no-verify`, discarding unfamiliar files.
9. **Don't game tests.** The docs' "Avoid focusing on passing tests and hardcoding" prompt says to write general solutions and to report incorrect tests instead of working around them.
10. **Ask for the shape of the final report.**
    - The Opus 5 guide says to lead with the outcome and gives cadence guidance for progress updates.
    - Opus 5's default responses run long, so ask for brevity explicitly.
    - Positive examples of the shape you want work better than prohibitions.
11. **Use structure.** Markdown headers and bullets are easier to follow than dense paragraphs (memory docs). Instructions that contradict each other get resolved arbitrarily, so the file defers to project files explicitly.

## Why each section exists

- **Intro paragraph.**
  - It tells the model that Zack often isn't watching. That justifies working end to end and caring about the final report.
  - It names the panels he actually sees.
  - It states that repo files win on conflict (finding 11).
- **The machine.**
  - Facts the model can't infer: root, `/root/workspace`, and that `gh` and git identity are already set up (`workspaces.ts` runs `gh auth login` and `git config`).
  - "Install freely" removes needless permission questions on a disposable VM.
  - Stop, hibernate and spot interruption are real for this app: `machines.ts` hibernates CPU types, and the image's spot watcher writes `/run/codespace/interruption`. Disk survives and processes don't, which is why "commit now" is tied to a concrete file to check.
  - Background servers with log files keep the turn from blocking on a long-running command, and reading the log replaces assuming the server started.
  - The GPU line exists because quietly falling back to CPU is a realistic failure.
- **Ports.**
  - The Ports panel tunnels a fixed remote port (`remote.ts` `forwardPort`). A random or unstated port is useless to Zack.
  - The reserved ports come from `remote.ts` and `workspaces.ts`: 7681 ttyd, 6080 noVNC, 5900 x11vnc, 22 sshd.
  - The `ss -ltnp` check plus "don't kill processes you didn't start" prevents clobbering his terminal or desktop.
- **Visual checks.**
  - Ubuntu 22.04's chromium is a snap, so the image ships Playwright's Chromium behind a `/usr/local/bin/chromium` wrapper with `PLAYWRIGHT_BROWSERS_PATH` set (`infra/image/setup.sh`). Without that line the model tends to `apt install chromium` or let Playwright download another copy.
  - The headless screenshot command is the cheapest visual check and follows the best-practices "verify UI changes visually" advice.
  - The desktop only exists while Zack has it open (`startDesktop` and `stopDesktop`), so the file says when `DISPLAY=:0` is valid and points to `xvfb-run` otherwise.
- **Before you change anything.**
  - Read repo instructions and code first (Anthropic's "investigate before answering").
  - The `git status` rule protects in-progress work, the "discard unfamiliar files" hazard from finding 8.
  - "Plan if you can't describe the diff in one sentence" is the best-practices heuristic, and "don't wait for approval" keeps the turn moving.
- **How to work.**
  - The first bullet adapts `default_to_action` and the Opus 5 scope prompt (findings 4 and 7).
  - The ask-list is the reversibility rule (finding 8), aligned with Zack's own global rule ("Ask before anything outward-facing").
  - Match style, focused diffs, root causes and parallelism come from findings 7 and 9 and the delegation damper. Each is phrased as a concrete action because the model already holds the generic version.
- **Git.** The user asked for branch-first and no push to main or force-push without asking. Frequent commits are the cheap insurance against interruption. Pushing one's own feature branch is allowed so work survives off-box; anything shared still needs a yes.
- **Secrets.** Required by the brief. The rule is concrete: where secrets go, a pre-commit check, and what to do when one is missing. Fake-looking placeholders are banned because they leak into commits and confuse later runs.
- **Done means verified.** This defines verification concretely instead of saying "double-check" (finding 6). Honest reporting of what wasn't verified is the one guarantee Zack can't get from the diff.
- **Final message.** Fixed headings give the outcome-first shape from finding 10. The last line counters Opus 5's verbosity.

## Deliberately left out

- **Parallel tool calls and "don't over-engineer" as generic advice.** Claude Code's system prompt already covers both, and current models parallelize unprompted. The file keeps only the environment-tuned versions: batch independent work, and a delegation threshold.
- **"Double-check", "re-verify", "use a subagent to verify".** The Opus 5 guide says these cause over-verification.
- **"Think carefully" and reasoning-format instructions.** Effort controls thinking, and asking the model to write out its reasoning can trigger `reasoning_extraction` refusals (Opus 5.5 guide).
- **CAPS emphasis and "IMPORTANT".** No single rule has proven to be skipped yet. Add emphasis to one line only if one is.
- **Repo overviews, tech-stack notes and style rules.** These belong in project files or linters (Gloaguen et al.; HumanLayer's "don't use it as a linter").
- **The Opus 5.5 "don't end your turn early" paragraph.** It's written for fully unattended loops. Codespace has a human in the loop, and the paragraph adds tool calls and tokens.
- **Progress-update cadence.** The composer shows progress notes, and Opus 5.5's defaults are reasonable. Only the final report is specified.
- **Hooks-only guarantees.** Rules that must hold every time with no exceptions, like running the formatter after edits, belong in hooks, not prose. None is configured here.
- **Paths from Zack's Mac (`~/Repos`, ColdArchive).** These come from his personal file, which is appended separately if he selects it. This file must stay true on the VM.
