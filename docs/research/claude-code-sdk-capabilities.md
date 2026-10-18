# Claude Code capability map: Agent SDK (TypeScript) + headless CLI

Research date: 2026-10-17. Purpose: list everything the Codespace composer can drive when it runs `claude` inside a workspace's Daytona sandbox for the user's own Claude subscription, and what each feature means for the UI.

## Sources and confidence markers

| Marker | Meaning |
|---|---|
| **[d.ts]** | Checked against the typings in `@anthropic-ai/claude-agent-sdk@0.3.302` (`sdk.d.ts`, `sdk-tools.d.ts`). This is the ground truth. |
| **[docs]** | Taken from code.claude.com docs (`agent-sdk/*`, `commands`, `cli-reference`, `permission-modes`, `interactive-mode`, `headless`, pulled 2026-10-17). |
| **[runtime]** | The method exists on the `Query` implementation in `sdk.mjs` but is **not declared in `sdk.d.ts`** and is not documented. It is callable with a cast (`(q as any).getPlan()`), but it is internal, can change without notice, and its response shapes are unknown. Treat it as **unverified**. |
| **[wire]** | A control-request type that `sdk.d.ts` declares but no `Query` method sends. Using it would mean writing raw control frames. **Unverified.** |
| **[T3]** | How T3 Code's `ClaudeAdapterV2.ts`, `ClaudeProvider.ts` and `Drivers/*` use the feature. "T3: skips" means T3 doesn't use it. |
| **UNVERIFIED** | Inferred but not confirmed in typings, docs or code. |

Local copies used: `scratchpad/sdkts.md` (SDK TS reference), `scratchpad/sdkpkg/package/*.d.ts`, `scratchpad/ccdocs/*.md`, `scratchpad/t3/t3code/apps/server/src`.

**Auth caveat [docs]:** the Agent SDK overview says *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products."* Codespace is a single-user tool that runs the user's own `claude` login inside their own sandbox, which is the same as running the CLI on a remote machine. Don't turn it into a multi-tenant product without checking the terms first. The documented auth paths are `claude setup-token`, which produces a long-lived OAuth token you pass as `CLAUDE_CODE_OAUTH_TOKEN`, and `claude auth login` run in a PTY. The SDK runtime also has `claudeAuthenticate` and `claudeOAuthCallback` control methods **[runtime]**.

---

## 1. Process model and remote execution

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Start a session | `query({ prompt, options }): Query`, an `AsyncGenerator<SDKMessage>` with control methods | One `Query` per live thread | [d.ts] |
| Run the CLI inside the Daytona sandbox | `options.spawnClaudeCodeProcess(opts: SpawnOptions) => SpawnedProcess`, where `SpawnOptions = {command,args,cwd,env,signal}` and `SpawnedProcess = {stdin: Writable, stdout: Readable, killed, exitCode, kill(), on('exit'/'error')}` | This is the core of the architecture. The SDK, and every host-side callback (`canUseTool`, hooks, `onElicitation`, `onUserDialog`, in-process MCP servers), runs on our server. Only the CLI runs in the sandbox, and NDJSON goes over stdio. | [d.ts] T3 skips it (local spawn only). We need a byte-clean, bidirectional stdio pipe into the sandbox: a Daytona session command with `runAsync` plus send-input and streamed logs, or a small relay process (WebSocket↔stdio) running in the sandbox. Don't use a PTY for the JSON channel, because echo and CRLF corrupt the NDJSON. **UNVERIFIED** which Daytona primitive keeps stdin/stdout clean. |
| Executable path | `pathToClaudeCodeExecutable`, `executable` (`bun`/`deno`/`node`), `executableArgs` | Pin the CLI version installed in the sandbox image | [d.ts] T3 uses `pathToClaudeCodeExecutable` |
| Extra CLI flags | `extraArgs: Record<string,string\|null>`, e.g. `{ "replay-user-messages": null }` | Escape hatch for flags the SDK doesn't model | [d.ts] T3 uses it |
| Environment | `env` **replaces** the subprocess env and is not merged | Inject `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, feature flags | [d.ts] |
| Pre-warm | `startup({options})` returns `WarmQuery` (initialize handshake already done); `prewarm()` returns `SpareProcess.claim()` (alpha; about 230–260 MB; set `options.cwd` to a path that exists remotely) | Hides cold-start latency when the user opens a thread | [docs] T3 skips `prewarm` |
| Re-handshake after a transport gap | `q.reinitialize()` redelivers pending `can_use_tool` / `request_user_dialog` | Reconnect logic when the sandbox link drops mid-turn | [d.ts] T3 skips it |
| Abort and close | `abortController`, `q.close()` | Hard stop, for example when a thread is closed | [d.ts] |
| Debugging | `debug`, `debugFile`, `stderr(cb)` | Diagnostics panel or log capture | [d.ts] |
| Anthropic-hosted alternative | `@anthropic-ai/claude-agent-sdk/browser` (SSE/WS to CCR `/v1/code/sessions`) and `/bridge` (`createCodeSession`, `attachBridgeSession`) | Not applicable, because these target Anthropic's cloud sessions and not our sandbox. Listed for completeness. | [d.ts] alpha |
| Change working directory mid-session | `q.setCwd(path, {trustAccepted, trustedDirectory})` | Repo-pinned threads; switching repos inside a workspace | **[runtime]** |

## 2. `query()` options (all 69 in `Options`)

| Option | UI implication | Notes |
|---|---|---|
| `cwd`, `additionalDirectories`, `projectConfigRoot` | Thread scope (whole workspace or one repo); other repos become extra dirs. `projectConfigRoot` loads `.claude/` from a trusted checkout when `cwd` is a worktree. | [d.ts] T3 passes its attachments dir as an additional dir |
| `model`, `fallbackModel` (comma list) | Model picker; fallback chain | [d.ts] |
| `effort` (`low\|medium\|high\|xhigh\|max`), `thinking` (`adaptive\|enabled{budgetTokens}\|disabled`), `maxThinkingTokens` (deprecated) | Effort slider; thinking toggle | [d.ts] T3 sends `thinking:{type:'adaptive',display:'summarized'}` plus `settings.showThinkingSummaries` |
| `permissionMode`, `allowDangerouslySkipPermissions`, `permissionPrompts: 'host'\|'none'`, `permissionPromptToolName`, `planModeInstructions` | Mode selector; whether approvals surface at all | [d.ts] |
| `canUseTool` | Approval cards and AskUserQuestion forms | See §5 |
| `allowedTools`, `disallowedTools`, `tools` (string[] or `{type:'preset',preset:'claude_code'}`), `toolAliases` | Tool loadout. `toolAliases` can redirect, for example, `Bash` to an MCP tool | [d.ts] |
| `toolConfig.askUserQuestion.previewFormat: 'markdown'\|'html'` | Option previews (mockups) in question cards | [d.ts][docs] T3 skips it |
| `systemPrompt` (string, string[] with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, or preset+`append`) | Custom instructions from the loadout | [d.ts] T3 uses preset+append |
| `settingSources` (`user`/`project`/`local`; `[]` = isolation) | Must include `project` to load CLAUDE.md, `.claude/skills`, and so on | [d.ts] |
| `settings` (path or object = flag layer), `managedSettings` | Push loadout settings (hooks, permissions, statusLine, autoCompactWindow...) | [d.ts] T3 uses `settings` |
| `agent`, `agents: Record<string,AgentDefinition>` | Main-thread persona; programmatic subagents from the catalog | [d.ts] T3 uses `agents` minimally |
| `skills: string[]\|'all'` | Skill loadout | [d.ts][docs] T3 parses SKILL.md files itself and doesn't use this option |
| `plugins: [{type:'local',path,skipMcpDiscovery}]`, `pluginDelivery: 'argv'\|'initialize'` | Plugin loadout (local paths in the sandbox only) | [d.ts] |
| `mcpServers`, `strictMcpConfig` | MCP loadout | §10 |
| `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, `includeHookEvents` | Host-side hooks; hook activity in the timeline | §8 |
| `onElicitation` | MCP form/URL elicitation modal | §10 |
| `onUserDialog`, `supportedDialogKinds` | CLI-initiated blocking dialogs (for example `resume_return`, `refusal_fallback_prompt`). The CLI emits only the kinds you declare. | [d.ts] T3 declares `['resume_return']` and renders it as an AskUserQuestion |
| `perTaskStopAffordance` | Declares a per-task Stop button. Interrupt then spares background agents. | [d.ts] T3 skips it |
| `includePartialMessages` | Token streaming | [d.ts] T3 turns it on |
| `forwardSubagentText` | Full nested subagent transcripts, not just tool calls | [d.ts] T3 skips it and uses `getSubagentMessages` afterwards |
| `agentProgressSummaries` | About every 30 s, a one-line "Analyzing X" on each running subagent (`task_progress.summary`) | [d.ts] T3 skips it |
| `promptSuggestions` | Ghost-text next-prompt suggestion (arrives after `result`) | [d.ts] T3 skips it |
| `verbatimPrompts` | Turns off `@path` expansion and `/command` dispatch for every message | [d.ts] |
| `resume`, `continue`, `sessionId`, `forkSession`, `resumeSessionAt`, `resumeDropsTurn`, `title` | Thread open, fork and rollback | §11 |
| `persistSession`, `sessionStore`, `sessionStoreFlush`, `loadTimeoutMs` | Mirror transcripts into our DB (alpha) | §11 |
| `enableFileCheckpointing` | Rewinding code | §12 |
| `outputFormat: {type:'json_schema',schema}` | Structured output (`result.structured_output`) | §17 |
| `maxTurns`, `maxBudgetUsd`, `taskBudget` (alpha) | Guardrails | [d.ts] |
| `sandbox: SandboxSettings` | Bash filesystem/network/credential isolation inside the sandbox | §18 |
| `betas` (`context-1m-2025-08-07`) | 1M context toggle (older Sonnet only) | [d.ts] |
| `abortController`, `env`, `executable*`, `extraArgs`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, `debug*`, `stderr` | Process plumbing | §1 |

## 3. Streaming input and the turn model

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Multi-turn over one process | `prompt: AsyncIterable<SDKUserMessage>` (streaming input mode). Most control methods require it. | A long-lived Query per open thread; the composer pushes into a queue | [docs][d.ts] T3 uses an AsyncIterable |
| Additional input stream | `q.streamInput(stream)` | Alternative feeding path | [d.ts] T3 skips it |
| Send while Claude works (queueing) | `SDKUserMessage.priority`: `'next'` (default: read after the current tool batch), `'later'` (new turn after this one), `'now'` (interrupt; with `origin:{kind:'human'}` it moves running shells, subagents and MCP calls to the background and steers) | The composer stays enabled during turns, with a "Send now / Queue" choice. Queued chips can be cancelled. | [docs] T3 uses `priority`/`origin` |
| Cancel a queued message | `q.cancelAsyncMessage(uuid)`; `interrupt()` returns `still_queued` uuids (`interrupt_receipt_v1` capability) | Remove a queued chip | cancelAsyncMessage is **[runtime]**; the receipt is [d.ts] |
| Inject context without a turn | `SDKUserMessage.shouldQuery: false` | "Attach output" from the terminal tab without spending a turn | [docs] |
| Pastes | `pasted_content[]`, `inline_pastes[]` | Wrap large pastes in `<pasted_content>` | [docs] |
| Message provenance | `origin: {kind:'human'\|'channel'\|'peer'\|'task-notification'\|'coordinator'\|'auto-continuation'\|'unclassified'}`, also echoed on `result.origin` | Always send `{kind:'human'}`, because some features (for example the `ultracode` keyword) need it. Label synthetic turns ("background task finished"). | [docs] |
| Interrupt | `q.interrupt()` | Stop button | [d.ts] T3 uses it |
| Images and PDFs | `message.content` image blocks (`{type:'image',source:{type:'base64',media_type,data}}`) and document blocks | Drag, drop or paste attachments | [docs] T3 writes attachments to a dir and also sends image blocks |
| `@file` mentions | Plain text `@path` is expanded by the CLI unless `client_composed` is set | Mention picker in the composer | [docs] |
| `@file` autocomplete | `file_suggestions` control request (fuzzy matching, like the TUI) | Picker results | **[wire]**, no Query method. Workaround: run `rg --files` in the sandbox. |

## 4. Every `SDKMessage` type and what it means for the UI

The `SDKMessage` union has 39 members [d.ts]. The "T3" column shows whether T3's adapter handles the type.

| Message (`type` / `subtype`) | Key fields | UI implication | T3 |
|---|---|---|---|
| `system/init` | `tools, mcp_servers[{name,status}], model, permissionMode, slash_commands, skills, plugins, plugin_errors, agents, output_style, effort, fast_mode_state, capabilities[], claude_code_version, apiKeySource` | Fill the toolbar (model, mode, effort), the command palette, the MCP status chip and plugin error toasts. Use the capability flags to gate features. | yes |
| `assistant` | `message: BetaMessage` (text, thinking, tool_use, server tool blocks), `parent_tool_use_id`, `agent_id`, `error`, `aborted`, `supersedes[]` | Main transcript bubbles. A non-null `parent_tool_use_id` nests the message under the parent Agent card. Retract anything listed in `supersedes`. | yes |
| `user` | `message` (tool_result blocks), `tool_use_result` (structured tool output; see Tool Output Types), `parent_tool_use_id`, `priority`, `origin`, `uuid` | Tool result rendering: diffs from Edit output, Bash output, AgentOutput. `{detachedToolCall:true}` means the call moved to the background. | yes |
| `user` (replay) | `isReplay` with uuid; needs `--replay-user-messages` | Gives the user-message UUID you need for checkpoints and rollback | yes, via resumeSessionAt |
| `stream_event` | `event: BetaRawMessageStreamEvent`, `parent_tool_use_id`, `ttft_ms` | Live token, thinking and tool-input streaming | yes (root only) |
| `result` (`success` or `error_during_execution`/`error_max_turns`/`error_max_budget_usd`/`error_max_structured_output_retries`) | `result, is_error, num_turns, total_cost_usd, usage, modelUsage, permission_denials[], structured_output, terminal_reason, stop_reason, api_error_status, errors[], startup_failure_reason, deferred_tool_use, fast_mode_state, queued_turn_count` | Turn complete: cost and token footer, error banner (`terminal_reason`, for example `prompt_too_long`, `blocking_limit`, `budget_exhausted`), denied-tools summary | yes |
| `system/status` | `status: 'compacting'\|'requesting'\|null`, `compact_result`, `compact_error` | "Compacting..." spinner; request in flight | yes |
| `system/compact_boundary` | `trigger: manual\|auto, pre_tokens, post_tokens, duration_ms, preserved_segment` | Divider reading "Conversation compacted (X→Y tokens)" | yes |
| `system/api_retry` | `attempt, max_retries, retry_delay_ms, error_status, error` | "Retrying in Ns (attempt 2/10)" banner | yes |
| `system/control_request_progress` | `request_id, status: started\|api_retry` | Progress on slow control calls (for example compact) | no |
| `system/model_refusal_fallback` | `original_model, fallback_model, direction, retracted_message_uuids` | Notice that the model switched, plus retraction of refused messages | yes |
| `system/model_refusal_no_fallback` | `api_refusal_category, content` | Refusal notice | no |
| `system/local_command_output` | `content` | Output of `/context`, `/usage` and similar commands rendered as a system card | no |
| `system/hook_started`, `hook_progress`, `hook_response` | `hook_name, hook_event, stdout, stderr, exit_code, outcome` | Hook activity rows (collapsible). Needs `includeHookEvents`; SessionStart and Setup are always emitted. | no |
| `system/plugin_install` | `status: started\|installed\|failed\|completed, name, error` | Plugin install progress toast | no |
| `system/task_started` | `task_id, run_id, tool_use_id, description, subagent_type, task_type (local_bash, subagent, monitor, workflow...), workflow_name, is_backgrounded, parent_task_id, spawn_depth, prompt` | Background-task tray entry; Agent card goes to "running" | yes |
| `system/task_progress` | `usage, last_tool_name, summary` | Live subagent status line | yes |
| `system/task_updated` | `patch {status: pending\|running\|completed\|failed\|killed\|paused, is_backgrounded, error}` | Tray state changes | no |
| `system/task_notification` | `status: completed\|failed\|stopped, output_file, summary, usage, resource_links` | Task finished; "View output" | yes |
| `system/background_tasks_changed` | `tasks[]` (full snapshot) | Source of truth for the tray | yes |
| `tool_progress` | `tool_use_id, tool_name, elapsed_time_seconds, heartbeat, subagent_retry` | Elapsed-time ticker on tool rows | no |
| `tool_use_summary` | `summary, preceding_tool_use_ids` | Collapse a run of tool calls into one line ("Read 6 files") | no |
| `system/thinking_tokens` | `estimated_tokens, delta` | "Thinking... ~2.1k tokens" counter | no |
| `system/session_state_changed` | `state: idle\|running\|requires_action` | Thread status dot; drives workspace Activity and idle timeout | no |
| `system/commands_changed` | `commands: SlashCommand[]` | Refresh the command palette | no |
| `system/notification` | `key, text, priority, color, timeout_ms` | Toast | partial |
| `system/informational` | `content, level: info\|notice\|suggestion\|warning, tool_use_id` | Inline notice | no |
| `system/memory_recall` | `mode, memories[{path,scope,content}]` | "Recalled N memories" chip | no |
| `system/permission_denied` | `tool_name, tool_use_id, decision_reason, message` | Mark the tool row "denied by rule/classifier" (auto mode) | no |
| `system/elicitation_complete` | `mcp_server_name, elicitation_id` | Close the URL-elicitation modal | no |
| `system/files_persisted` | `files[], failed[]` | Upload confirmations (cloud file persistence) | no |
| `system/mirror_error` | `error, key` | Session-store mirror failure warning | no |
| `system/worker_shutting_down` | `reason` | "Agent restarting" banner | no |
| `auth_status` | `output[], error` | Login flow output | no |
| `rate_limit_event` | `rate_limit_info {status: allowed\|allowed_warning\|rejected, rateLimitType: five_hour\|seven_day\|..., utilization, resetsAt, overage*}` | Plan-usage meter; "limit resets at..." banner | yes |
| `prompt_suggestion` | `suggestion` | Ghost text in the composer | no |
| `conversation_reset` | `new_conversation_id, trigger: clear\|plan_mode_exit\|fresh_session` | Divider: "context cleared" (after `/clear` or "approve plan and clear") | no |
| `active_goal` (declared but not in the union) | `condition, iterations` | `/goal` status chip | **UNVERIFIED** whether it's emitted |
| `keep_alive` (internal) | none | Ignore | [d.ts] |

## 5. Permissions, approvals, AskUserQuestion

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Approval callback | `canUseTool(toolName, input, {signal, suggestions, blockedPath, decisionReason, title, displayName, description, defaultToNo, suppressAlwaysAllowRule, toolUseID, agentID, requestId, mcpServer, matchedAskRule})` returns `PermissionResult` | Approval card with Allow / Deny / "Always allow...". Use `title`/`description` as headers. When `defaultToNo` is set, focus Deny. When `suppressAlwaysAllowRule` is set, hide "always". Show `agentID` when a subagent is asking. | [d.ts][docs] Called only when evaluation resolves to "ask". Prompts never time out. The `signal` aborts when the turn is interrupted. |
| Allow, edit or deny | `{behavior:'allow', updatedInput?, updatedPermissions?, decisionClassification}` / `{behavior:'deny', message, interrupt?}` | "Edit command before running"; "Deny and tell Claude why"; "Deny and stop" | [d.ts] |
| Permission suggestions | `suggestions: PermissionUpdate[]` (`addRules/replaceRules/removeRules/setMode/addDirectories/removeDirectories` × destination `userSettings/projectSettings/localSettings/session/cliArg`) | "Always allow `npm test` (this project)" buttons, one per suggestion | [d.ts] T3 rewrites every suggestion to the `session` destination |
| Out-of-band answer | Return `null` after sending your own `control_response` that echoes `requestId` | Multi-client or approval by phone | [docs] |
| List and edit rules | `q.listPermissionRules()`; `applyFlagSettings({permissions})`; `updateSettings('localSettings'\|'userSettings', ...)` (allowlisted keys only) | A `/permissions` panel | listPermissionRules is **[runtime]** (response type `SDKControlListPermissionRulesResponse` is in d.ts) |
| Per-MCP-server tightening | `q.setMcpPermissionModeOverride(server, 'default'\|'auto'\|null)` | "Always ask for this server" toggle | [d.ts] |
| Live mode switch | `q.setPermissionMode(mode)` | Shift+Tab-style mode cycler in the composer | [d.ts] T3 uses it |
| Modes | `default`, `acceptEdits`, `bypassPermissions` (needs `allowDangerouslySkipPermissions`), `plan`, `dontAsk` (deny anything not pre-approved), `auto` (classifier; needs a supported model) | Mode pill with explanations. Auto-mode denials arrive as `system/permission_denied`. | [docs] Rules that never auto-approve: AskUserQuestion, MCP tools with `requiresUserInteraction`, `rm`/`rmdir` |
| AskUserQuestion | The tool reaches `canUseTool` with `{questions:[{question, header(≤12 chars), options[2-4]{label, description, preview?}, multiSelect}]}` (1–4 questions). Answer with `{behavior:'allow', updatedInput:{questions, answers:{[questionText]: label \| labels-joined-with-", " \| free text}}}` | Question card with chips, multi-select and an "Other" text field. Previews render markdown or sandboxed HTML. | [docs][d.ts] T3 implements this with deferred answers |
| No approval surface | `permissionPrompts:'none'` | Unattended runs (scheduled jobs) | [d.ts] |

## 6. Plan mode and the ExitPlanMode flow

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Enter plan mode | `permissionMode:'plan'` / `setPermissionMode('plan')`; Claude can also call `EnterPlanMode`; `/plan <desc>` | Plan toggle in the composer | [docs][d.ts] |
| Edits blocked while planning | File edits and modifying shell commands always reach `canUseTool` in plan mode, even when allow rules match | Plan mode shows no edit approvals: auto-deny edits, or show "Claude wants to edit in plan mode" | [docs] |
| Plan proposal | Claude calls `ExitPlanMode`, which goes to `canUseTool`. The plan text is in the input (`plan`; schema is `[k:string]:unknown`) and `ExitPlanModeOutput{plan, filePath, planWasEdited}` | Plan review panel (markdown) with buttons: **Approve and auto** / **Approve, accept edits** / **Approve, review each edit** / **Keep planning (feedback)** / optionally **Approve and clear context** | [docs] the CLI's choices. To approve: return `allow` (optionally `updatedInput` with an edited plan) and call `setPermissionMode('acceptEdits'\|'auto'\|'default')`. To keep planning: `deny` with the feedback as the message. |
| Fetch the current plan | `q.getPlan()` | "View plan" at any time | **[runtime]** |
| Custom plan workflow | `planModeInstructions` | Loadout-level planning recipe | [d.ts] |
| Plan file location | settings `plansDirectory` (default `~/.claude/plans/`) | Link to the plan file in the sandbox | [docs] |
| T3 behavior | T3 **denies** ExitPlanMode with "client captured your plan; wait for the user". It renders the plan and restarts the next turn in the mode the user picked. It resets the mode when Claude entered plan mode on its own. | Simpler than holding the callback open, but it costs a turn | [T3] |

## 7. Models, effort, thinking, fast mode

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| List models | `q.supportedModels(): ModelInfo[]` (`value, displayName, description, supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode, supportsAutoMode`); also `initializationResult().models` | Model picker that knows which models support effort and auto | [d.ts] T3 keeps its own model manifest |
| Switch model | `q.setModel(model)` or `applyFlagSettings({model})` | Mid-thread model switch. Switching to a model without auto support drops the session to `default` mode. | [d.ts][docs] T3 uses `applyFlagSettings` |
| Effort | `options.effort`; mid-session through `applyFlagSettings({effortLevel})` or `updateSettings('userSettings',{effortLevel})` | Effort slider | [d.ts] **UNVERIFIED** that the `effortLevel` flag key changes effort live; T3 relies on it |
| Thinking | `options.thinking`; `setMaxThinkingTokens(n, display)` (deprecated) | Show thinking blocks (summarized or omitted) | [d.ts] |
| Fast mode | `fast_mode_state`/`fast_mode_disabled_reason` on init and result; settings `fastMode` | Fast toggle with a reason tooltip | [d.ts] |
| Advisor model | settings `advisorModel`; `/advisor` | Advanced setting | [d.ts] |
| PreModelSwitch/PostModelSwitch hooks | hooks | n/a | [d.ts] |

## 8. Hooks (33 events)

There are two kinds. **SDK callback hooks** (`options.hooks`) run on our server and travel over the control channel, so they work with remote spawn. **Settings hooks** (shell or HTTP commands in `settings.json` or plugins) run inside the sandbox. Callback output: `{continue, suppressOutput, stopReason, decision, systemMessage, reason, hookSpecificOutput}`; `PreToolUse` can return `permissionDecision allow|deny|ask|defer`, `updatedInput`, `additionalContext`. `AsyncHookJSONOutput` exists for fire-and-forget. `HookCallbackMatcher{matcher, hooks[], timeout}`. [d.ts]

| Event | UI implication |
|---|---|
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` | Policy enforcement, audit log, auto-format after edits, our own diff and checkpoint capture |
| `PermissionRequest` / `PermissionDenied` | Mirror approvals into the activity feed |
| `UserPromptSubmit` / `UserPromptExpansion` | Inject loadout context, expand macros |
| `SessionStart` / `SessionEnd` / `Setup` | Workspace bootstrap such as env and git status context |
| `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop` | Notifications ("thread finished"), keep-going loops |
| `PreCompact` / `PostCompact` | Compaction UI; save the pre-compact transcript |
| `PreModelSwitch` / `PostModelSwitch` | Model change audit |
| `Notification` | Push or browser notifications ("Claude needs input") |
| `TaskCreated` / `TaskCompleted` / `TeammateIdle` | Task list and team UI |
| `Elicitation` / `ElicitationResult` | Auto-answer MCP prompts |
| `ConfigChange` / `InstructionsLoaded` / `CwdChanged` / `FileChanged` / `DirectoryAdded` | "CLAUDE.md loaded" chip; file watcher refresh |
| `WorktreeCreate` / `WorktreeRemove` | Worktree list in the workspace |
| `MessageDisplay` (`turn_id, message_id, index, final, delta`) | Alternative streaming tap |
| Hook listing | `q.getHooksListing()` (**[runtime]**) builds a `/hooks` viewer; `includeHookEvents` drives the timeline rows |

## 9. Slash commands, custom commands, skills

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Discover commands | `system/init.slash_commands` (names), `q.supportedCommands(): SlashCommand[]{name, description, argumentHint, aliases, builtin}`, `initializationResult().commands`, `system/commands_changed` | Command palette with descriptions and argument hints | [d.ts][docs] T3 uses `initializationResult()` in a probe |
| Dispatch | Send `/<name> args` as prompt text | Palette inserts the text | [docs] An unknown `/x` goes to the model with a note. A TUI-only built-in returns "isn't available in this environment". |
| Headless-capable built-ins | Docs example list: `clear`, `compact`, `context`, `usage`, plus bundled skills (`code-review`, `verify`, `simplify`, `run`, `loop`, `debug`, `init`, ...) | Show only the commands that `init` lists | [docs] Interactive-only ones such as `/theme` and `/terminal-setup` are excluded |
| `/compact [focus]` | Prompt text; produces `status: compacting` then `compact_boundary` | Compact button with an optional focus field | [docs] |
| `/clear` | Prompt text; produces `conversation_reset` | "New context" button; the old session stays resumable | [docs] |
| Custom commands | `.claude/commands/*.md` (legacy) and skills | Catalog item; appears after `reloadSkills()` | [docs] |
| Skills | `.claude/skills/<name>/SKILL.md` and `~/.claude/skills`; `options.skills`; `system/init.skills`; `q.reloadSkills()`; `q.getSkillsDialog()` (**[runtime]**) | Skills browser; enable or disable per loadout. A skill has no programmatic registration, so write files into the sandbox. | [docs][d.ts] |
| MCP prompts as commands | MCP servers can expose prompts as `/server:prompt` | Appear in the palette | [docs] |

## 10. MCP

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Server types | `stdio {command,args,env}`, `sse {url,headers}`, `http {url,headers}`, `sdk` (in-process via `createSdkMcpServer({name,tools:[tool(name,desc,zodShape,handler)]})`), `claudeai-proxy` (claude.ai connectors, status only) | Catalog: add MCP server. stdio servers run in the sandbox; SDK servers run on our host. | [d.ts] T3 injects its own in-process MCP server through `setMcpServers` |
| Live add and remove | `q.setMcpServers(record): McpSetServersResult` | Loadout changes without restart | [d.ts] |
| Status | `q.mcpServerStatus(): {name, status: connected\|failed\|needs-auth\|pending\|disabled, error, serverInfo, tools[{name, annotations}], scope, source}` | MCP panel with per-server state, tool list and errors | [d.ts] T3 skips it |
| Reconnect and toggle | `q.reconnectMcpServer(name)`, `q.toggleMcpServer(name, enabled)` | Buttons in the panel | [d.ts] |
| OAuth for HTTP servers | `q.mcpAuthenticate(server, redirectUri)`, `q.mcpSubmitOAuthCallbackUrl(server, url)`, `q.mcpClearAuth(server)` | "Authenticate" button: open the auth URL and paste back or forward the callback | **[runtime]**. Documented fallback: `claude mcp login <name> --no-browser` in a PTY |
| Elicitation | `onElicitation(req{mode:'form'\|'url', requested_schema, property_order, url, title})` returns `{action:'accept'\|'decline'\|'cancel', content}` | Dynamic form modal or "open this URL" modal | [d.ts] T3 skips it |
| MCP Apps UI | `q.readMcpResource(server, 'ui://...')` when a tool declares `_meta.ui.resourceUri` | Render the tool widget in a sandboxed iframe | [d.ts] needs the `mcp_read_resource_v1` capability |
| Resource links | `tool_use_result.resourceLinks[]` | File chips | [docs] |
| Tool policy | `sdkMcpServerConfigs.tools[].permission_policy` | Per-tool always allow, ask or deny | [d.ts] (initialize request) |
| Scope control | `strictMcpConfig` | Loadout is the only MCP source | [d.ts] |
| Channels | `q.enableChannel(...)`; `origin.kind='channel'` | Messages pushed from an MCP channel | **[runtime]** |

## 11. Sessions

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Session id | `session_id` on every message | Thread ↔ session mapping | [d.ts] |
| Resume | `options.resume`, `continue`; `onUserDialog('resume_return')` offers to compact an old session | Reopen a thread | [d.ts] T3 uses it |
| Fork | `options.forkSession` (with `resume`); `forkSession(id, {upToMessageId, title})` returns `{sessionId}` | "Branch from here" | [d.ts] T3 uses `forkSession()` |
| Rollback to a message | `resumeSessionAt: uuid` plus `resumeDropsTurn` (validates what gets discarded) | "Edit and resend" or "Undo last turn" for the conversation | [d.ts] T3 uses it for rollback |
| List, get, rename, tag, delete | `listSessions({dir, limit, offset, includeWorktrees, includeProgrammatic})`, `getSessionInfo`, `getSessionMessages(id, {includeSystemMessages, limit, offset})`, `renameSession`, `tagSession`, `deleteSession`; live `q.renameSession`, `q.generateSessionTitle` (**[runtime]**) | Thread list and history. **These read the local `~/.claude/projects`, which is on our host and not in the sandbox.** For remote runs, use `sessionStore` or read the JSONL in the sandbox. | [d.ts]. The remote caveat is inferred: **UNVERIFIED** |
| Subagent transcripts | `listSubagents(sessionId)`, `getSubagentMessages(sessionId, agentId)` | Expand a finished subagent | [d.ts] T3 uses `getSubagentMessages` |
| Session store mirror | `sessionStore {append, load, listSessions, listSessionSummaries, delete, listSubkeys}`, `InMemorySessionStore`, `importSessionToStore`, `foldSessionSummary` (alpha) | Keep transcripts in the Codespace DB so they survive sandbox deletion and cold starts | [d.ts] `load()` materializes to a temp JSONL "in the SDK parent". **UNVERIFIED** that this works when the CLI is remote. |
| Export | `q.exportConversation()` | Export button | **[runtime]** |
| Settings resolution | `resolveSettings()`, `q.getSettings()` (**[runtime]**) | Effective-settings inspector | [d.ts] |

## 12. File checkpointing and rewind

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Enable | `enableFileCheckpointing:true` plus `extraArgs:{'replay-user-messages':null}` to receive user-message UUIDs | Rewind affordance on every user message | [docs] |
| Rewind files | `q.rewindFiles(userMessageId, {dryRun})` returns `{canRewind, error, filesChanged, insertions, deletions}` | "Restore code to here" with a dry-run diff preview. Combine with `resumeSessionAt` for "restore code and conversation" (the `/rewind` equivalent). | [d.ts] |
| Limits | Tracks only Write, Edit and NotebookEdit. Bash changes and most subagent edits are **not** tracked. | Warn that "shell changes are not reverted". Consider git snapshots per turn, as T3 does. | [docs] T3 uses its own git-based CheckpointStore and skips rewindFiles |
| Seed read state | `q.seedReadState(path, mtime)` | Prevents a "file not read yet" error after context edits | [d.ts] |

## 13. Subagents, background agents, tasks, workflows, monitors

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Define agents | `agents: Record<name, AgentDefinition{description, prompt, tools, disallowedTools, model, mcpServers, skills, initialPrompt, maxTurns, background, memory, effort, permissionMode, omitClaudeMd, autoCompactWindow}>`; `.claude/agents/*.md` | Catalog agents | [d.ts] |
| List agents | `q.supportedAgents(): AgentInfo[]`, `init.agents` | Agent picker | [d.ts] |
| Agent tool call | `tool_use` named `Agent` with `{description, prompt, subagent_type, model, effort, run_in_background (default **true**), name, isolation: 'worktree'\|'remote'}` | Collapsible Agent card. Child messages carry `parent_tool_use_id` = the Agent `tool_use.id` (and `agent_id`). The result comes as `tool_use_result: AgentOutput`. | [d.ts][docs] |
| Nested transcript | `forwardSubagentText:true` (live) or `getSubagentMessages` (after) | Expandable child timeline | [d.ts] |
| Background tasks | `task_started / task_progress / task_updated / task_notification / background_tasks_changed` | Task tray (shells, subagents, monitors, workflows) | [d.ts] T3 handles them |
| Stop, background, output | `q.stopTask(taskId)`, `q.backgroundTasks(toolUseId?)` (Ctrl+B), `q.getTaskOutput(taskId)` (last 8 KiB; **[runtime]**) | Per-task Stop, "Move to background", live output tail | T3 uses stopTask and backgroundTasks, and tails a private file (`<tmp>/claude-<uid>/.../tasks/<id>.output`) instead of getTaskOutput |
| Monitor tool | `Monitor{description, timeout_ms, command\|ws}`: each stdout line is an event | Watcher rows in the tray | [d.ts] |
| Workflows | `Workflow` tool (`script`/`name`/`args`/`resumeFromRunId`); `task_started.workflow_name`; `.claude/workflows/`; settings `enableWorkflows`/`disableWorkflows` | Workflow progress card. The `/workflows` progress view is TUI-only. | [d.ts] |
| Cron, loops, wakeups | `CronCreate/CronDelete/CronList`, `ScheduleWakeup` tools; `SessionCronSummary` in Stop hook input | "Scheduled in this thread" list. These run only while the process lives, so the sandbox must stay up. | [d.ts] |
| Teams and peers | `SendMessage`, `ListAgents`, `origin.kind='peer'` | Advanced: agent-team UI | [d.ts][docs] |
| Worktrees | `EnterWorktree/ExitWorktree` tools, `isolation:'worktree'`, WorktreeCreate hook | Show worktrees in the workspace | [d.ts] |

## 14. Todos and task lists

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| TodoWrite (older models) | `tool_use` `TodoWrite{todos[{content, status: pending\|in_progress\|completed, activeForm}]}`; the full list is replaced each call | Sticky checklist panel; the `activeForm` text drives the spinner | [d.ts] T3 renders root-level TodoWrite as a plan |
| Task tools (newer) | `TaskCreate{subject, description, activeForm, metadata}`, `TaskUpdate{taskId, status\|deleted, addBlocks, addBlockedBy, owner}`, `TaskGet`, `TaskList`; hooks `TaskCreated`/`TaskCompleted` | Build the list incrementally with dependencies | [d.ts][docs] Depends on the model. Force it with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. A shared list uses `CLAUDE_CODE_TASK_LIST_ID`. |

## 15. Compaction, context, usage, cost, rate limits

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Manual compaction | `/compact [focus]` | Button | [docs] |
| Auto-compaction | `status:'compacting'`, `compact_boundary{trigger:'auto'}`; settings `autoCompactEnabled`, `autoCompactWindow`, `idleCompaction` | Divider plus spinner; setting in the loadout | [d.ts] T3 sets `autoCompactWindow` |
| Context usage | `q.getContextUsage({detail:'summary'\|'full'})` returns `{model, total_tokens, raw_max_tokens, percentage, over_limit, categories[], mcp_tools[], memory_files[], agents[], skills[]}` | Context ring in the composer plus a `/context`-style breakdown | [d.ts] T3 skips it and derives usage from token counts |
| Per-turn cost and tokens | `result.total_cost_usd, usage, modelUsage{per model}` | Turn footer | [d.ts] With a subscription the cost is notional. |
| Plan usage windows | `rate_limit_event` (live) and `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})` returns `{session{cost, lines, model_usage}, rate_limits{five_hour, seven_day, seven_day_opus, seven_day_sonnet, model_scoped, extra_usage}, behaviors}` | 5-hour and 7-day meters like `/usage` | [d.ts] experimental. T3 parses transcript JSONL for usage instead. |
| Usage-limit text | `USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_WARNING_PREFIXES` exported | Classify error results | [d.ts] |
| Session status | `q.getStatus()` | `/status` panel (version, account, connectivity) | **[runtime]** |
| Account | `q.accountInfo()` returns `{email, organization, subscriptionType, tokenSource, apiProvider}` | Account chip; detect a lost login | [d.ts] T3 reads it through `initializationResult()` |

## 16. Settings sources, CLAUDE.md, memory, output styles

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| CLAUDE.md and rules | Loaded when `settingSources` includes `project` (and `user` for `~/.claude/CLAUDE.md`); `InstructionsLoaded` hook | "Instructions" catalog items written as files in the sandbox | [d.ts][docs] |
| Auto memory | settings `autoMemoryEnabled`, `autoMemoryDirectory`; `system/memory_recall`; `AgentDefinition.memory` | Memory viewer; recalled-memory chip | [d.ts] |
| Memory dialog | `q.getMemoryDialog()` | `/memory` equivalent | **[runtime]** |
| Live settings | `q.applyFlagSettings(obj)` (flag layer, shallow merge); `q.updateSettings('localSettings'\|'userSettings', obj)` (allowlisted keys such as `outputStyle`, `effortLevel`) | Settings panel that applies without a restart | [d.ts] T3 uses both |
| Output styles | `init.output_style`, `initializationResult().available_output_styles`, `q.reloadOutputStyles()`, settings `outputStyle` (via `updateSettings('localSettings',{outputStyle})`) | Style picker | [d.ts] |

## 17. Structured output

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| JSON Schema output | `outputFormat:{type:'json_schema', schema}` returns `result.structured_output`; failures end with `error_max_structured_output_retries` | Mostly for background automations (for example generating a PR title). Not a chat feature. | [d.ts][docs] |
| Side question | `q.askSideQuestion(question, {history})` returns `{response, synthetic}` without adding to the transcript | `/btw` side panel | **[runtime]** |

## 18. Sandboxing (inside the Daytona sandbox)

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Bash sandbox | `sandbox:{enabled, failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands, excludedCommands, filesystem{allowWrite, denyWrite, allowRead, denyRead}, network{allowedDomains, deniedDomains, strictAllowlist, allowLocalBinding, httpProxyPort, socksProxyPort, tlsTerminate}, credentials{files, envVars, awsPairs, maskClaims}, ignoreViolations, enableWeakerNestedSandbox}` | Optional. The Daytona sandbox already isolates the workspace, but in-sandbox bwrap can still stop exfiltration of the OAuth token. Needs bubblewrap and socat in the image (`enableWeakerNestedSandbox` for containers). | [d.ts] **UNVERIFIED** whether bwrap works inside Daytona |
| Per-command escape | `BashInput.dangerouslyDisableSandbox` shown in approvals | Flag it in the approval card | [d.ts] |
| Sandbox dialog | `q.getSandboxDialog()` | n/a | **[runtime]** |

## 19. Plugins and marketplaces

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Load local plugins | `plugins:[{type:'local', path}]`; `init.plugins`/`plugin_errors` | Catalog plugin that is a directory in the sandbox | [d.ts] Only `local` is supported |
| Marketplaces and installs | settings `enabledPlugins`, `extraKnownMarketplaces`; `system/plugin_install` events. The CLI command `claude plugin install/marketplace add` | Marketplace browser: the server runs `claude plugin ...` in the sandbox, then calls `q.reloadPlugins({addPlugins?})` | [d.ts][docs] **UNVERIFIED** whether the headless CLI auto-installs `enabledPlugins` from marketplaces at startup (the `plugin_install` message suggests it does) |
| Reload | `q.reloadPlugins({holdOnCacheImpact})` returns `{commands, agents, plugins, mcp status, held, cache_impact}` | "Apply" button with a warning about cache invalidation | [d.ts] |

## 20. Status line, notifications, misc

| Feature | SDK API | UI implication | Notes/source |
|---|---|---|---|
| Status line | settings `statusLine` runs a shell script with session JSON on stdin. This is a TUI feature. | Build our own status bar from init, result, context usage and rate limits. Optionally run the user's statusLine script ourselves with equivalent JSON. | [docs] **UNVERIFIED** whether it ever runs headless (assume not) |
| Notifications | `system/notification`, `Notification` hook, `PushNotification` tool | Browser or phone push | [d.ts] |
| Feedback and ratings | `q.submitFeedback`, `q.messageRated` | Thumbs up/down | **[runtime]** |
| Prompt-suggestion pause | `q.setPromptSuggestionsPaused` | n/a | **[runtime]** |
| Ultrareview | `q.launchUltrareview` | Cloud review button | **[runtime]** |
| Chrome | `getChromeDialog/getChromeBrowsers/selectChromeBrowser/setChromeBrowserHints` | Not applicable in a remote sandbox | **[runtime]** |
| Remote Control | `remote_control` control subtype; `claude remote-control` | Not needed (we are the remote) | **[wire]** |
| Read file through the CLI | `q.readFile(path, {maxBytes, encoding})` (respects Read permission rules) | Sidebar file viewer without a separate Daytona FS call | [d.ts] |
| Built-in tool names | `BUILTIN_TOOL_NAMES` (54 tools, including Artifact, Projects, ClaudeDesign, ReportFindings...) | Tool-specific renderers for the common ones (Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, Agent, TodoWrite, Task*, AskUserQuestion, ExitPlanMode, NotebookEdit, Monitor, Workflow) and a generic JSON renderer for the rest | [d.ts] |

---

## T3 Code prior art: what it uses and what it skips

- **Uses:** `query()` with AsyncIterable input, `includePartialMessages`, `model`/`effort`/`thinking`, `permissionMode`, `allowedTools`/`disallowedTools`/`tools`, `canUseTool` (generic approvals, AskUserQuestion, ExitPlanMode deny-and-capture, suggestions moved to the session scope), `onUserDialog`+`supportedDialogKinds:['resume_return']`, `resume`/`sessionId`/`resumeSessionAt`, `forkSession()`, `getSubagentMessages`, `listSessions`/`getSessionMessages`/`deleteSession` (history worker), `setMcpServers` (its own orchestration MCP), `applyFlagSettings`/`updateSettings` (live model and effort), `setModel`, `setPermissionMode`, `interrupt`, `stopTask`, `backgroundTasks`, `initializationResult()` (account and commands probe), `systemPrompt` preset+append, `settings` (`autoCompactWindow`, `showThinkingSummaries`), `extraArgs`, `env`, `pathToClaudeCodeExecutable`, `additionalDirectories`, message priority and origin. It handles these messages: stream_event, assistant, user, result, rate_limit_event, api_retry, compact_boundary, model_refusal_fallback, task_started/progress/notification, background_tasks_changed, init/status.
- **Skips:** `spawnClaudeCodeProcess` (local only), `enableFileCheckpointing`/`rewindFiles` (uses git checkpoints), `hooks`/`includeHookEvents`, `plugins`/`reloadPlugins`, `skills` option (parses SKILL.md itself), `outputFormat`, `sandbox`, `sessionStore`, `promptSuggestions`, `agentProgressSummaries`, `forwardSubagentText`, `perTaskStopAffordance`, `toolConfig` previews, `onElicitation`, `mcpServerStatus`/reconnect/toggle, `getContextUsage`, the usage API (parses JSONL instead), `supportedModels`/`supportedCommands`/`supportedAgents`, `accountInfo`, `streamInput`, `reinitialize`, `prewarm`. Unhandled messages: tool_progress, tool_use_summary, session_state_changed, hook_*, permission_denied, informational, local_command_output, commands_changed, task_updated, thinking_tokens, prompt_suggestion, conversation_reset, memory_recall, elicitation_complete.
- **Lesson:** T3 works around missing features with private CLI file layouts (task output files, transcript JSONL). Those are fragile. Prefer the SDK APIs above, and `getTaskOutput` once it is stable.

---

## Composer must-haves vs nice-to-haves

### Must-haves (v1)
1. A remote spawn transport (`spawnClaudeCodeProcess` → Daytona) with reconnect (`reinitialize`) and an auth bootstrap (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`).
2. A streaming-input thread with a live token stream (`includePartialMessages`), a stop button (`interrupt`), and queued or steering messages (`priority`, `origin:{kind:'human'}`).
3. A transcript renderer for assistant text and thinking, tool cards (Bash, Read, Edit/Write diffs, Grep/Glob, Web*), and nested subagent cards keyed by `parent_tool_use_id`.
4. Approval cards from `canUseTool` with suggestions ("always allow"), edit-input and deny-with-reason, plus the AskUserQuestion form.
5. A permission-mode pill (`setPermissionMode`), and plan mode with an ExitPlanMode review panel (approve into a chosen mode, or keep planning).
6. A model and effort picker (`supportedModels`, `setModel`, `applyFlagSettings`).
7. Turn result footer (cost, tokens, errors with `terminal_reason`), `api_retry` banner and a `rate_limit_event` usage meter.
8. Context meter (`getContextUsage('summary')`), a `/compact` button, and auto-compact divider and spinner.
9. Thread list with resume and fork (`resume`, `forkSession`), plus a transcript mirror (`sessionStore`, or reading the sandbox JSONL) so history survives sandbox churn.
10. Command palette from `supportedCommands()` and `commands_changed`, with dispatch of `/name args`.
11. Background-task tray (`task_*`, `background_tasks_changed`) with Stop (`stopTask`, `perTaskStopAffordance`) and "move to background" (`backgroundTasks`).
12. Todo/task checklist panel (TodoWrite plus Task* tools).
13. Image and file attachments (base64 image and document blocks) and `@path` mentions.
14. Loadout application: `settingSources`, `settings`, `agents`, `skills`, `plugins`, `mcpServers` written or applied for each workspace.
15. A PTY terminal tab into the sandbox, the fallback for everything that is CLI-only.

### Nice-to-haves (later)
- File checkpoint rewind (`enableFileCheckpointing`, `rewindFiles` dry-run preview) combined with `resumeSessionAt` for full `/rewind`.
- MCP panel: status, reconnect/toggle, OAuth (`mcpAuthenticate`, [runtime]), elicitation modal, MCP Apps iframes.
- Hook timeline (`includeHookEvents`) and a hooks viewer.
- Prompt suggestions (ghost text), agent progress summaries, forwarded subagent text, tool-use summaries, thinking-token counter.
- Plan-usage dashboard (`usage_EXPERIMENTAL...`), `/status` panel (`getStatus`, [runtime]).
- Side questions (`askSideQuestion`, [runtime]), export (`exportConversation`, [runtime]), title generation.
- Plugin marketplace browser (CLI `claude plugin` in the sandbox, then `reloadPlugins`).
- Output-style picker, memory viewer, permission-rule editor (`listPermissionRules`, [runtime]).
- Structured-output background jobs (PR titles, commit messages).
- `prewarm`/`startup` for instant thread start; per-server MCP permission overrides; in-sandbox `sandbox` settings for token exfiltration defense.

---

## Gaps (CLI-only) and workarounds

| CLI-only feature | Why it's a gap | Workaround |
|---|---|---|
| `/login`, `/logout`, interactive OAuth | No documented SDK login | `claude setup-token` once, stored as a secret → `CLAUDE_CODE_OAUTH_TOKEN`; or `claude auth login` in the PTY tab; or `claudeAuthenticate`/`claudeOAuthCallback` [runtime, unverified] |
| `/mcp` OAuth login panel | No documented SDK call | `claude mcp login <name> --no-browser` in the PTY; `mcpAuthenticate` [runtime] |
| `/plugin` marketplace UI, `/plugin install` | SDK only loads local plugin paths | Run `claude plugin marketplace add/install` in the sandbox, then `reloadPlugins()` |
| `/rewind` picker (code + conversation + "summarize from here") | No single API | `rewindFiles` + `resumeSessionAt`/`forkSession`; "summarize from here" has no equivalent |
| Status line script | TUI renders it | Build our own status bar, or run the user's script with synthesized JSON |
| `/context` colored grid, `/usage` and `/stats` tabs, `/status`, `/doctor` | TUI dialogs | `getContextUsage`, `usage_EXPERIMENTAL`, `getStatus` [runtime], and `local_command_output` from sending `/context` |
| `/permissions`, `/hooks`, `/agents`, `/skills`, `/memory`, `/config` dialogs | Interactive menus | Our panels backed by `listPermissionRules`/`getHooksListing`/`getSkillsDialog`/`getMemoryDialog` [runtime], `supportedAgents`, `applyFlagSettings`/`updateSettings`, and direct file edits in the sandbox |
| `/btw` side questions | TUI command | `askSideQuestion` [runtime] |
| `/diff` panel | TUI | `git diff` through the Daytona API; Edit/Write `tool_use_result` diffs |
| `/export`, `/copy` | TUI and clipboard | `exportConversation` [runtime] or render from transcript; browser clipboard |
| `/tasks` detail view, `/workflows` progress view | TUI | Task tray from `task_*` events plus `getTaskOutput` [runtime]; workflow card from `task_started.workflow_name` |
| `/resume` picker, `/branch`, `/rename` | TUI | `listSessions`/`sessionStore`, `forkSession`, `renameSession` |
| Ctrl+G edit plan in editor | TUI | Plan panel editor → `allow` with an edited plan in `updatedInput` (**UNVERIFIED** field name; `ExitPlanModeOutput.planWasEdited` suggests it is supported) |
| `!` shell mode, Ctrl+R history, vim mode, themes, keybindings, `/terminal-setup`, `/voice`, spell check | Terminal UX | PTY tab for shell; our own composer history and keybindings; browser speech APIs |
| Session recap, "you should know" notes | Interactive only | `generateSessionTitle` [runtime] or a cheap summarization call |
| Agent view / `--bg` background sessions / `claude attach`/`daemon` | Separate CLI process model | Our server keeps the Query alive across browser disconnects; or run `claude --bg` in the sandbox and `claude attach` in the PTY |
| Remote Control, `/teleport`, `/desktop`, `/remote-env`, cloud `/schedule` routines, `/autofix-pr`, `/ultrareview` | Anthropic-cloud features | Mostly unnecessary; `launchUltrareview` [runtime] exists |
| IDE integration (`/ide`), Claude in Chrome (`/chrome`) | Local-machine integrations | Not applicable in the sandbox; use a Playwright or Chrome DevTools MCP server in the sandbox instead |
| `/insights`, `/team-onboarding`, `/powerup`, `/radio`, `/stickers`, `/mobile`, `/passes`, `/release-notes`, `/heapdump`, `/bug`/`/feedback` UI | Non-essential TUI | Skip; `submitFeedback` [runtime] if needed |
| Wire-only control requests: `file_suggestions`, `get_session_cost`, `get_binary_version`, `register_repo_root`, `set_color` | Declared in d.ts, no Query method | Raw control frames over our own transport (**UNVERIFIED**); for `@` autocomplete, `rg --files` in the sandbox |

**General fallback:** every composer workspace gets a **PTY tab** (Daytona PTY) running the interactive `claude --resume <sessionId>` against the same `CLAUDE_CONFIG_DIR`. Anything the SDK can't do, the user can do in the real TUI. Don't run the PTY TUI and the SDK Query on the same session at the same moment: concurrent writers to one transcript is **UNVERIFIED**, and `startup_failure_reason: 'session_held_by_background'` suggests the CLI enforces a lock.
