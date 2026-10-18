# Daytona capabilities map (for the codespace app)

Researched 2026-10-17 against Daytona Cloud docs (llms-full generated 2026-10-17), the published OpenAPI specs in `github.com/daytona/clients` (`openapi-specs/api.json`, `openapi-specs/toolbox.json`), the TypeScript SDK source (`sdk-typescript/src/*.ts`), `github.com/daytona/integrations`, `github.com/daytona/guides`, and the `daytonaio/sandbox:0.10.0` image config pulled from Docker Hub. Daemon versions seen in the wild: 0.222.x.

Legend: **[doc]** = stated in Daytona docs, **[spec]** = OpenAPI / SDK source, **[image]** = read from the image build history, **[UNVERIFIED]** = inference or conflicting sources. Test those items before you depend on them.

Doc root: `https://www.daytona.io/docs/en/<page>.md`. The short links below use `docs:` for that prefix.

---

## 0. Findings that change the design

1. **The default per-sandbox cap is 4 vCPU / 8 GiB RAM / 10 GiB disk** [doc, docs:sandboxes.md#resources]. 10 GiB of disk is tight for several repos with `node_modules`, Claude Code state and Chromium caches. To raise it, or to resize a sandbox in place, you have to contact support (`support@daytona.io`). Volumes do not solve this: they are FUSE over S3, slower than local disk, and cannot provide block storage.
2. **The default snapshot already includes Claude Code 2.1.220, Node 25, Python 3.14, git, Chromium, ripgrep, ffmpeg and the full VNC desktop** [doc+image]. It runs as user `daytona` with passwordless sudo in `/home/daytona`. It does **not** include `gh` or Docker.
3. **Daytona Secrets give you the "token never enters the sandbox" pattern.** The sandbox only ever holds a placeholder, and the egress proxy swaps in the real value only in HTTPS *headers* sent to allowlisted hosts. Daytona documents a recipe for git push: store a pre-encoded Basic header, pass it with `http.extraHeader`, and set `http.sslCAInfo`. See §2.4.
4. **Daytona has no built-in git push approval, branch protection or git audit.** Gating has to come from you, from GitHub (rulesets, fine-grained tokens, GitHub Apps), or from attaching and detaching secrets just in time. Secret changes take effect within seconds and are recorded in Daytona audit logs.
5. **Any Daytona API key, even one with zero scopes, has full toolbox (root-equivalent) access to every running sandbox in the org** [doc, docs:api-keys.md]. The sandbox-wide **preview token** reaches the terminal on port 22222, the toolbox on 2280 and recordings on 33333. Keep both on the Next.js server and never put them in the browser bundle or inside a sandbox.
6. **Idle handling: container sandboxes auto-stop after 15 minutes by default**, and that kills Claude processes because a stop loses memory. **Linux VM sandboxes can *pause* instead**, keeping memory so running Claude sessions survive. They also support fork, which suits personal workspaces. Background processes never count as activity, so the app should call `POST /sandbox/{id}/last-activity` as a heartbeat while the UI is open.
7. **GPU sandboxes are a poor fit for workspaces.** They are always ephemeral (deleted on stop), have no pause, are not covered by free credits, and run in the virtual "earth" region. Nothing documents computer use or VNC support for them, and the desktop runs on Xvfb (software framebuffer), so a GPU would not accelerate it [UNVERIFIED].
8. **Webhooks require a public HTTPS endpoint (Svix) and must be enabled per org.** A local Next.js app needs a tunnel or has to poll.
9. **Previews in an iframe show Daytona's warning page** unless you send `X-Daytona-Skip-Preview-Warning: true` (header only), are on Tier 3, or run a custom preview proxy. If the Next.js server proxies previews, it can add that header.
10. **Tiers 1 and 2 cannot set per-sandbox egress allowlists, and VPN needs Tier 3.** The default egress policy still reaches the "essential services" (GitHub, npm, PyPI, Anthropic, and others), so a personal app works on Tier 1/2 without custom allowlists.

---

## 1. What a sandbox exposes by default

### 1.1 Sandbox classes and default snapshots [doc, docs:sandboxes.md, docs:snapshots.md#default-snapshots]

| Snapshot | vCPU | RAM | Disk | Class |
|---|---|---|---|---|
| `daytona-small` (default) | 1 | 1 GiB | 3 GiB | Container |
| `daytona-medium` | 2 | 4 GiB | 8 GiB | Container |
| `daytona-large` | 4 | 8 GiB | 10 GiB | Container |
| `daytona-gpu` | 1 | 1 GiB | 1 GiB | GPU (1 GPU) |
| `daytona-vm-small/medium/large` | 1/2/4 | 1/4/8 GiB | 3/8/10 GiB | Linux VM |
| `windows-small/medium/large` | 1/2/4 | 4/8/16 GiB | 30/50/50 GiB | Windows |

macOS sandboxes are provided through the separate use.computer platform, which has its own API key [doc].

### 1.2 Default image contents [image: `daytonaio/sandbox:0.10.0`; versions match the doc table]

- The base is the devcontainers `python:3.14-trixie` image (Debian Trixie), with the devcontainer features `common-utils`, `git` (built from source) and `node`.
- **User and paths**: `USER daytona`, home `/home/daytona`, `daytona ALL=(ALL) NOPASSWD:ALL`. `/usr/local/lib` and the nvm directory are owned by `daytona`, so `npm i -g` works without sudo. The entrypoint is `sleep infinity`, and the daemon runs separately.
- **Runtimes**: Python 3.14.6 at `/usr/local/python/current`, Node **25** through nvm at `/usr/local/share/nvm`, Bun 1.3.6, uv 0.9.26 and pipx.
- **apt packages**: `curl sudo python3-pip python3-venv ripgrep chromium iputils-ping bind9-dnsutils ffmpeg xvfb x11vnc novnc xfce4 xfce4-terminal dbus-x11 at-spi2-core`, plus the X11 libraries. `git`, `openssh-client`, `subversion`, `mercurial`, gcc/g++ and the usual build dependencies are also present.
- **Global npm packages**: `@anthropic-ai/claude-code@2.1.220`, `@openai/codex@0.146.0`, `opencode-ai@1.18.14`, `openclaw`, `typescript@5.9.3`, `ts-node`, `typescript-language-server@5.1.3`, `bun`.
- **pip packages**: `anthropic`, `claude-agent-sdk`, `openai`, `openai-agents`, `daytona` (0.203.0), `python-lsp-server`, `torch`, `transformers`, `pandas`, `numpy`, `django`, `flask`, `langchain`, `llama-index`, `pydantic-ai`, and more.
- **Not included**: `gh` (the Devin and Flue guides install it with `apt-get install gh`), `docker`, and `tmux` [UNVERIFIED for tmux, since the full common-utils package list was not checked].
- **[UNVERIFIED]** that `daytona-vm-*` and `daytona-gpu` ship the same userland. The docs say the default Linux VM snapshots include the VNC packages, but nothing says whether they include Claude Code.

### 1.3 In-sandbox daemon ("Toolbox API") [doc, docs:architecture.md; spec toolbox.json]

The daemon runs inside every sandbox and exposes the Toolbox API, internally on port **2280**. Clients reach it through Daytona's proxy:

`{sandbox.toolboxProxyUrl}/{sandboxId}/{endpoint}`. On Daytona Cloud that is `https://proxy.app.daytona.io/toolbox/{sandboxId}/...`.

- Auth is `Authorization: Bearer <DAYTONA_API_KEY>` (from Node).
- The SDK's browser and serverless mode instead appends `?DAYTONA_SANDBOX_AUTH_KEY=<previewToken>` to WebSocket URLs [spec, `utils/WebSocket.ts`].
- **Toolbox calls reset the auto-stop timer.**

Full endpoint list [spec]:

| Area | Endpoints |
|---|---|
| Files | `GET /files` (ls), `GET /files/info`, `GET /files/download`, `POST /files/bulk-download`, `POST /files/upload-v2`, `POST /files/bulk-upload`, `POST /files/folder`, `DELETE /files`, `POST /files/move`, `POST /files/permissions` (mode/owner/group), `GET /files/find` (grep content), `GET /files/search` (glob names), `POST /files/replace` |
| Signed file URLs | SDK `sandbox.downloadUrl(path, ttl)` / `uploadUrl(path, ttl)` return pre-signed URLs that need no headers (signing key per sandbox, `POST /sandbox/{id}/signing-key/rotate` revokes them). These are a good fit for browser downloads. |
| Git | see §2 |
| Process | `POST /process/execute` (one-shot, cwd/timeout/env), `POST /process/code-run`. Sessions: `POST/GET/DELETE /process/session[/{id}]`, `POST /process/session/{id}/exec` (sync or async), `GET .../command/{cmdId}`, `GET .../command/{cmdId}/logs` (HTTP or **WebSocket follow**), `POST .../command/{cmdId}/input` (stdin). Entrypoint: `GET /process/session/entrypoint[/logs]` |
| Code interpreter | `POST/GET/DELETE /process/interpreter/context`, `GET /process/interpreter/execute` (WebSocket, stateful Python contexts) |
| PTY | `POST /process/pty` (`id, cwd, envs, cols, rows, lazyStart`), `GET /process/pty`, `GET/DELETE /process/pty/{id}`, `GET /process/pty/{id}/connect` (**WebSocket**), `POST /process/pty/{id}/resize` |
| LSP | `POST /lsp/start\|stop\|did-open\|did-close\|completions`, `GET /lsp/document-symbols`, `GET /lsp/workspacesymbols` (Python via pylsp, TS via typescript-language-server, both preinstalled) |
| Computer use | see §4 |
| Ports | `GET /port` (listening ports), `GET /port/{port}/in-use`. Use these to auto-discover dev servers for the preview panel. |
| Env | `POST /env` (`set`, `unset`, `unsetValuePrefix`): changes the daemon env for **newly spawned** processes, sessions and PTYs. SDK: `sandbox.updateEnv()`. |
| System | `GET /system/metrics` (CPU%, memory, disk), `GET /version`, `GET /user-home-dir`, `GET /work-dir`, `POST /init` |
| Not present | **There is no file-watch or inotify endpoint.** Poll, or run your own watcher in a session and stream its logs. |

From the main API you also get metrics history (`sandbox.getMetrics(start, end)`) and OTel telemetry (`GET /sandbox/{id}/telemetry/logs|traces|metrics`). Org-level OTLP export is configured with `PUT /organizations/{id}/otel-config`, and per sandbox with `otelEndpointOverride` [spec].

### 1.4 Ports and services running in a default sandbox [doc, docs:custom-preview-proxy.md, docs:preview.md, docs:web-terminal.md]

| Port | Service | Notes |
|---|---|---|
| 2280 | Toolbox API (daemon) | Reserved, always needs auth, even on public sandboxes |
| 22222 | Web terminal | Reserved, always needs auth. Open it as `getPreviewLink(22222)` or as a signed preview URL. The `public` flag does not apply. |
| 33333 | Screen-recordings dashboard | Reserved |
| noVNC port | Browser VNC client | Started by `computerUse.start()`. **The port number is not documented. It is commonly 6080 [UNVERIFIED].** Confirm with `GET /port` after start. |
| X display | `DISPLAY=:0` | Used by the integrations' Chromium launcher [spec, integrations/claude-toolsets/src/chromium.ts] |
| SSH | Through the gateway `ssh <token>@ssh.app.daytona.io` | Not a sandbox port. Tokens default to 60 minutes and are revocable. |

Any process listening on ports 1–65535 can be previewed at `https://{port}-{sandboxId}.{proxyDomain}` (for example `proxy.daytona.work`). HTTP and WebSocket both work.

### 1.5 Preview auth details [doc, docs:preview.md]

- **Standard preview URL plus token** (`x-daytona-preview-token` header):
  - The token is **sandbox-wide**: it covers every port, including 2280 and 22222.
  - It **cannot be revoked**.
  - It **changes when the sandbox is stopped and started**, but survives pause/resume.
- **Signed preview URL** `https://{port}-{token}.{domain}`:
  - Scoped to one port.
  - TTL from 1 second to 24 hours (default 60 seconds; set it explicitly).
  - Survives restarts.
  - Revocable per token, or all at once by rotating the signing key.
  - This is the one to embed in iframes (terminal, VNC, app preview).
- **`public: true`** removes auth from all non-reserved preview ports. The claude-toolsets README warns that this exposes the Chromium CDP port and the noVNC desktop.
- **Warning page** appears for browser requests. Ways to skip it:
  - Send `X-Daytona-Skip-Preview-Warning: true`.
  - Be on Tier 3+.
  - Use a custom proxy.
  - Accepting the page sets a 24-hour cookie.
- **Other proxy headers**:
  - `X-Daytona-Disable-CORS: true` (the default CORS policy allows all origins with credentials).
  - `X-Daytona-Skip-Last-Activity-Update: true`.
  - `X-Daytona-Trust-Forwarded-Host: true` (only with a valid preview token).
- Custom preview proxy samples: `github.com/daytona/daytona-proxy-samples`.

### 1.6 Dashboard features (app.daytona.io) [doc]

- **Sandboxes**: create, start/stop/pause, archive, fork, delete, labels, web terminal (`>_`), VNC, Screen Recordings, Create SSH Access.
- **Org resources**: Snapshots (incl. VM class), Volumes, Secrets, Warm pools (feature-flagged), Webhooks (Svix portal, feature-flagged).
- **Admin and observability**: Audit Logs (with auto-refresh), Limits, Billing (wallet, spending per sandbox), API Keys, Regions, SSO, Playground (sandbox, terminal and VNC tabs with codegen), telemetry logs/traces/metrics.
- **Linked accounts** (Google, GitHub) are for **login only**, not for repo access [doc, docs:linked-accounts.md].

### 1.7 Other per-sandbox features

- Labels.
- Env vars (`envVars`; they appear in the dashboard, so put secrets in Secrets).
- Volumes (FUSE/S3, up to 100 per org, free, not counted in storage quota, `subpath` isolation).
- Linked sandboxes (ephemeral children on the same runner sharing a link network, reachable by name or ID).
- VPN (Tailscale, OpenVPN, Netbird; Tier 3+).
- `kvm` nested virtualization (Linux VM only, org feature flag).
- `outboundProxyUrl`.
- `ttlMinutes` wall-clock TTL.
- `queueTimeout`.

---

## 2. Git

### 2.1 Toolbox and SDK git operations [spec toolbox.json, SDK `Git.ts`; docs:git-operations.md]

| SDK (`sandbox.git.*`) | Toolbox endpoint | Notes |
|---|---|---|
| `clone(url, path, branch?, commitId?, username?, password?, insecureSkipTls?, depth?)` | `POST /git/clone` | Per-call credentials, shallow clone, detached commit |
| `status(path)` | `GET /git/status` | `currentBranch`, `ahead`/`behind`, `branchPublished`, `upstream`, `detached`, `fileStatus[]` |
| `branches`, `createBranch`, `deleteBranch`, `checkoutBranch(path, branchOrSha)` | `/git/branches`, `/git/checkout` | |
| `add(path, files)` | `POST /git/add` | |
| `commit(path, msg, author, email, allowEmpty?)` | `POST /git/commit` | Returns `sha` |
| `push(path, username?, password?, branch?, remote?, setUpstream?)` | `POST /git/push` | Per-call credentials |
| `pull(path, username?, password?, branch?, remote?)` | `POST /git/pull` | |
| `init(path, bare?, initialBranch?)` | `POST /git/init` | |
| `reset(path, mode?, target?, files?)` | `POST /git/reset` | Modes: soft, mixed, hard, merge, keep |
| `restore(path, files, source?, staged?, worktree?)` | `POST /git/restore` | |
| `remoteAdd(path, name, url, fetch?, overwrite?)`, `remotes`, `remoteGet` | `/git/remotes` | |
| `setConfig`, `getConfig(key, scope, path?)`, `configureUser(name, email, scope, path?)` | `/git/config`, `/git/config/user` | Scopes: global, local, system |
| `dangerouslyAuthenticate(user, pass, host='github.com', protocol='https')` | `POST /git/credentials` | **Writes plaintext to the git credential store on disk** |
| history (toolbox only) | `GET /git/history` | |
| **Missing** | — | No fetch-only, merge, rebase, diff, log-range, tag, stash, or worktree. Use `process.executeCommand('git ...')` for those. |

### 2.2 Credential handling options

1. **Per-call `username`/`password` on clone, push and pull.**
   - The token travels from your server through the Daytona API/proxy to the daemon inside the sandbox.
   - It is not persisted according to the API shape, but it passes through a process running inside the sandbox [UNVERIFIED whether it ever lands on disk or in the remote URL].
   - The agent never sees it unless it inspects daemon memory.
2. **`dangerouslyAuthenticate`**: plaintext `~/.git-credentials`. The agent can read it. Avoid.
3. **Env var `GH_TOKEN`**: the Flue guide's default. The agent can read it with `env`. Avoid.
4. **Daytona Secrets plus the egress proxy**: recommended, see §2.4.

### 2.3 Built-in GitHub/GitLab integration, branch protection, push approval, audit

- **There is no GitHub App integration and no OAuth repo linking.** Linked accounts cover login only.
- Git hosts (GitHub, GitLab, Bitbucket, Azure DevOps, code.storage) are on the essential-services egress list, so they are reachable on every tier by default [doc, docs:network-limits.md#essential-services].
- **No branch protection, push approval or git-level audit exists in Daytona.**
- Daytona audit logs record the sandbox actions `update_secrets`, `update_network_settings`, `create_ssh_access`/`revoke_ssh_access`, `update_public_status`, `fork`, `snapshot`, and others. Secret create/update/delete are logged with values masked. Git pushes themselves are not recorded [doc, docs:audit-logs.md].
- What Daytona does provide for safe agent pushes:
  - Secrets with host allowlists, so the token can't be exfiltrated or sent anywhere else.
  - Response scrubbing, so the agent can't read the token even when a server echoes it back.
  - Per-sandbox domain/CIDR allowlists or block-all (Tier 3+).
  - `outboundProxyUrl` to chain egress through **your** proxy.
  - Audit of secret attach/detach.
  - Short-lived scoped SSH tokens.
  - Managed API keys for scoped child keys.
- The Cursor guide relies on Cursor minting short-lived GitHub tokens per run. That is Cursor's mechanism, not Daytona's [doc].

### 2.4 Exactly how to supply a GitHub token without exposing it [doc: docs:secrets.md; Flue guide in llms-full "Build an Autonomous Bug-Fix Agent with Flue and Daytona"]

How Secrets work:

1. `daytona.secret.create({ name, value, hosts })` stores an org-scoped, encrypted secret. Daytona returns a placeholder of the form `dtn_secret_<random>`. The value is never returned again.
2. `daytona.create({ secrets: { ENV_NAME: 'secret-name' } })` sets `ENV_NAME=<placeholder>` in the sandbox. You can change the mapping later with `sandbox.updateSecrets({...})` (`PUT /sandbox/{id}/secrets`). The map **replaces** the previous set, and `{}` detaches everything. Changes apply to egress "within seconds", but new env vars only reach processes spawned afterwards. **A sandbox created with no secrets must be restarted before newly attached secrets work.** Practical consequence: always create workspaces with at least one secret.
3. The egress proxy MITMs HTTPS. If a **request header** contains the placeholder unmodified **and** the destination host matches the secret's `hosts`, it substitutes the real value. It does not substitute in bodies, query strings, plain HTTP, or transformed (for example base64-encoded) values. It also scrubs the real value out of responses.
4. The proxy's CA reaches curl, Node, Python and Go through `CURL_CA_BUNDLE`, `SSL_CERT_FILE` "and friends". **Git does not read those variables**, so it needs `http.sslCAInfo`.
5. Requirements: `@daytona/sdk` ≥ 0.192.0. `manage:secrets` is needed to create or update secrets. `write:sandboxes` is enough to mount *any* org secret into a sandbox, and for a secret without `hosts` that means effectively reading it. **Always set `hosts`.** Rotating a value keeps the same placeholder and propagates within about 15 seconds.

Recipe (from the docs):

```ts
// once, server side
await daytona.secret.create({ name: 'github-token', value: TOKEN, hosts: ['api.github.com'] })        // gh CLI / REST
await daytona.secret.create({ name: 'github-git-auth',
  value: 'Basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64'), hosts: ['github.com'] }) // git over HTTPS

const sb = await daytona.create({ secrets: { GH_TOKEN: 'github-token', GH_GIT_AUTH: 'github-git-auth' } })
await sb.process.executeCommand(
  'git config --global http.sslCAInfo "$CURL_CA_BUNDLE" && ' +
  'git config --global http.https://github.com/.extraHeader "AUTHORIZATION: $GH_GIT_AUTH"')
// gh: install with `sudo apt-get install -y gh`; it sends GH_TOKEN verbatim in Authorization -> substituted.
```

Inside the sandbox, `env` shows only `dtn_secret_...` values, while `git push` and `gh pr create` work. Don't use `gh auth setup-git`, `curl --user` or credential helpers: they base64-encode the placeholder, so the proxy can't substitute it.

Push-gating patterns built on top [UNVERIFIED, these need testing]:

- **(a) Least-privilege token.** Use a fine-grained PAT or a GitHub App installation token limited to the workspace's repos, combined with **GitHub rulesets** that protect default branches and require PRs. This puts enforcement on GitHub, where the agent can't touch it.
- **(b) Just-in-time write secret.**
  - Keep a read-only token secret attached permanently for clone and fetch.
  - Keep the write-token secret detached.
  - On user approval in the UI: call `updateSecrets` to attach it, run `git -c http.https://github.com/.extraHeader= -c http.https://github.com/.extraHeader="AUTHORIZATION: $GH_PUSH_AUTH" push ...` (the empty value resets the multi-valued key), then detach.
  - Daytona's audit log records each `update_secrets`.
  - Note that during the attach window, any process in the sandbox can use the placeholder to hit github.com.
- **(c) Push from the app instead of from the agent.**
  - The agent commits only. The UI shows the diff.
  - On approval, the server calls `sandbox.git.push(path, 'x-access-token', TOKEN, branch, 'origin', true)`.
  - Simple, but the token transits the in-sandbox daemon.
- **(d) Your own egress proxy** via `outboundProxyUrl` plus a `domainAllowList` (Tier 3+) to log or block `git-receive-pack`.
  - Whether Daytona's proxy hands decrypted traffic to your upstream or tunnels it with CONNECT is **not documented**.
  - Whether Secrets substitution happens before chaining is also **not documented**.

The same mechanism can keep `ANTHROPIC_API_KEY` out of the sandbox: use a secret with `hosts: ['api.anthropic.com']`, which Claude Code sends as the `x-api-key` header [UNVERIFIED but matches the header-substitution rule]. Claude.ai subscription OAuth refresh flows use request bodies, so they would not work with this. A long-lived `CLAUDE_CODE_OAUTH_TOKEN` sent as a Bearer header might [UNVERIFIED].

---

## 3. Network

[doc, docs:network-limits.md, docs:isolation.md]

- **Per-sandbox egress firewall.** There are four knobs:
  - `networkBlockAll`
  - `networkAllowList`: IPv4 CIDRs, at most 10
  - `domainAllowList`: at most 100 entries, `*.` wildcards allowed
  - `outboundProxyUrl`
- **Mutual exclusion**: block-all and the two allowlists are mutually exclusive. Sending a conflicting combination returns 400.
- **Changing settings**: `POST /sandbox/{id}/network-settings` updates block-all and the allowlists live, with no restart. `outboundProxyUrl` can only be set at create time.
- **Defaults per tier**:
  - **Tier 1 and 2**: egress is *restricted* to the org policy, which includes the essential services. Sandbox-level allowlists can't override it, and the update API errors.
  - **Tier 3 and 4**: full internet by default. A sandbox-level allowlist or block-all is **strict**: essential services are *not* auto-allowed, so you must list github.com, registry.npmjs.org, \*.anthropic.com and so on yourself.
  - Audit records an org-level `update_sandbox_default_limited_network_egress` action.
- **Essential services** reachable under the default policy:
  - Package registries: npm, yarn, bun, PyPI/astral, crates, Go, Maven, NuGet, RubyGems, Hex, Packagist, Ubuntu/Debian repos.
  - Git hosts: GitHub incl. `*.githubusercontent.com` and ghcr.io, GitLab, Bitbucket, Azure DevOps.
  - AI providers: Anthropic (`*.anthropic.com`, `claude.ai`, `*.claude.ai`, `platform.claude.com`), OpenAI, Google, OpenRouter, and others.
  - Docker registries, CDNs, Vercel, Supabase, Neon, Clerk, Sentry, Linear, Playwright CDN, and more.
- **`outboundProxyUrl`**:
  - Daytona sets `HTTP_PROXY`/`HTTPS_PROXY` and chains through its own egress proxy to your upstream.
  - Accepts http or https, credentials in userinfo, at most 2048 characters, no localhost/private IP.
  - Clients that ignore the proxy env bypass it unless you also set `domainAllowList`.
- **Inbound** traffic only arrives through authenticated previews or the SSH gateway. There is no sandbox-to-sandbox network except linked sandboxes.
- **Secrets proxy**: sandboxes with secrets route HTTPS through the MITM egress proxy (see §2.4).

---

## 4. Computer use and VNC

### 4.1 API [spec toolbox.json, SDK `ComputerUse.ts`; docs:computer-use.md, docs:vnc-access.md]

| Area | Endpoints and methods |
|---|---|
| Lifecycle | `computerUse.start()` starts Xvfb, xfce4, x11vnc and novnc. `start()` returns before the desktop is usable, so poll `getStatus()` until it reports `active`. Also: `stop()`, `getStatus()`, `getProcessStatus(name)`, `restartProcess(name)`, `getProcessLogs(name)`, `getProcessErrors(name)`. |
| Mouse | `getPosition`, `move`, `click(x, y, button, double?, …)`, `down`, `up`, `drag`, `scroll`. Modifier chords are supported. |
| Keyboard | `type(text, delay?)`, `press(key, modifiers)`, `hotkey('ctrl+v')`, `down`, `up` |
| Screenshot | full screen, region, compressed (`format`, `quality`, `scale`, `showCursor`) |
| Display | `getInfo()` (displays and geometry), `getWindows()` |
| Recording | `recording.start(label)`, `stop(id)`, `list`, `get`, `delete`, `download(id, path)` (mp4, needs ffmpeg). There is also a dashboard on port 33333. |
| Accessibility (AT-SPI) | `getTree`, `findNodes`, `focusNode`, `invokeNode(id, action)`, `setNodeValue` |

- **Resolution**: set with the `VNC_RESOLUTION` env var at **create time only**. The default is 1024x768; the range is 640–7680 by 480–4320. It applies to Linux **container** sandboxes only. **Linux VM and Windows run at a fixed resolution.** Passing custom env vars bypasses warm pools.
- **VNC panel options for the app**:
  - Get a signed preview URL for the noVNC port and iframe its `vnc.html` [UNVERIFIED path/port].
  - Or reverse-proxy it through the Next.js server with the preview token.
  - noVNC WebSockets skip the warning page [doc].
- **Browser inside the desktop**: `/usr/bin/chromium` on `DISPLAY=:0`. Launch it through an async session, because it never returns.
  - For agent browser automation, the integrations' `DaytonaBrowser` drives Chromium over CDP through a 2-minute signed preview URL scoped to the debugging port. It runs headless by default; headed puts it on the VNC desktop.
  - The code is open source: `github.com/daytona/integrations/packages/claude-toolsets`.

### 4.2 Which snapshots support it

| Snapshot | Support |
|---|---|
| Default container snapshots | Yes [doc] |
| Default Linux VM snapshots | Yes [doc], at a fixed resolution |
| Windows | Yes [doc] ("Computer Use is available for Linux and Windows") |
| macOS | Through use.computer |
| Custom images or snapshots, including custom VM snapshots | Only if you install `xvfb xfce4 xfce4-terminal x11vnc novnc dbus-x11` plus the X11 libraries (and ffmpeg for recording) |

### 4.3 GPU sandboxes and the desktop

- **Nothing documents computer use or VNC on GPU sandboxes.** `daytona-gpu` is a "default snapshot", but its contents are not listed [UNVERIFIED].
- The desktop is **Xvfb** (in-memory software framebuffer) plus x11vnc. Even if it runs, rendering is CPU-only, so the GPU does **not** accelerate the VNC desktop or Chromium compositing without custom VirtualGL/EGL setup [UNVERIFIED inference].
- GPU facts [doc, docs:sandboxes.md#gpu-sandboxes, docs:regions.md#earth-region, docs:limits.md]:
  - **Types**: H100, H200, B200, B300, RTX-PRO-6000, RTX-4090, RTX-5090, AMD MI355X.
  - **Size**: up to 8 GPUs; each GPU adds up to 16 vCPU, 192 GB RAM and 512 GB disk.
  - **Lifecycle**: always ephemeral, deleted on stop. Pause and fork are not supported.
  - **Region**: on shared regions they run in **"earth"**, a virtual global region that ignores your `target`. `GET /organizations/{id}/gpu-capacity` returns on-demand and spot capacity.
  - **Quota**: GPUs have their own quota and don't count against the tier pool, so on-demand GPU doesn't require Tier 3. **Spot requires Tier 2+.** Spot can be preempted without warning (`spotEvictedAt` is set).
  - **Credits**: free credits don't apply.
  - **Pricing** (daytona.io/pricing, labelled "preemptible", $/h): B300 4.08, B200 3.59, MI355X 3.44, H200 2.61, H100 2.27, RTX PRO 6000 1.74, RTX 5090 0.74, RTX 4090 0.57. On-demand GPU prices are not listed.

---

## 5. Linux VM vs container sandboxes

[doc, docs:sandboxes.md, docs:snapshots.md, docs:limits.md#disk-quota, docs:billing.md]

| | Container (default) | Linux VM |
|---|---|---|
| Isolation | Namespaces/cgroups; "code runs as root inside the sandbox" | Own kernel (hardware virtualization) |
| Start | <90 ms from warm | Slower [UNVERIFIED by how much] |
| Pause/resume (memory kept) | No | **Yes**, and CPU is not billed while paused |
| Auto-pause | No | Yes; the default is **60 minutes** when neither auto-stop nor auto-pause is set. It is mutually exclusive with auto-stop. **Preview traffic does not reset it.** |
| Fork (filesystem and memory, fork tree, `/forks`, `/parent`, `/ancestors`) | No | Yes. A parent can't be deleted while it has forks. |
| Hot snapshot (memory) | No (cold, filesystem only) | Yes |
| Archive | Yes. Stopped sandboxes are auto-archived after 7 days by default (max 30); archived ones aren't billed or counted against quota. | No. Stop or pause already offloads state and **frees disk quota** (disk is still billed). |
| Stopped disk quota | Counts until archived | Freed |
| Dockerfile or declarative builds | Yes | **No**. Create the snapshot from a registry image ref or from a running VM. |
| VNC resolution | Configurable at create | Fixed |
| Docker inside | Via a custom DinD snapshot (`docker:28.3.3-dind` and similar); at least 2 vCPU / 4 GiB recommended | Presumably native, since it has a full kernel [UNVERIFIED] |
| Nested virtualization (`/dev/kvm`) | No | `kvm: true`, org feature flag `sandbox_kvm` |
| Per-sandbox caps | Same org cap: 4/8/10 by default | Same; default VM snapshots match the container sizes |
| Pricing | $0.0504/vCPU-h, $0.0162/GiB-h RAM, $0.000108/GiB-h disk (first 5 GiB free), billed per second | **No separate Linux VM price on the pricing page** [UNVERIFIED that it equals container pricing]. Windows is $0.0858/vCPU-h. |
| Region availability | us, eu | Check `GET /organizations/{id}/available-sandbox-classes`. The Cursor guide targets VMs at `eu-central-1` [UNVERIFIED shared availability]. |

Billing by state applies to both classes:

| State | What is billed |
|---|---|
| Started and transitional states | Everything |
| Stopped or paused | Disk only |
| Archived or deleted | Nothing (snapshots are billed for storage) |

---

## 6. Activity and lifecycle

### 6.1 Defaults [doc, docs:sandboxes.md#automated-lifecycle-management]

| Setting | Default and behaviour |
|---|---|
| `autoStopInterval` | **15 minutes**. 0 disables it. |
| `autoPauseInterval` | VM only; 60 minutes. |
| `autoArchiveInterval` | 7 days. 0 means the maximum, 30 days. |
| `autoDeleteInterval` | Unset means never. 0 deletes on stop, -1 disables. |
| `ttlMinutes` | Wall-clock TTL; destroys the sandbox in any state. |
| `ephemeral` | Same as auto-delete 0. |

Setters: `setAutostopInterval`, `setAutoPauseInterval`, `setAutoArchiveInterval`, `setAutoDeleteInterval`, `setTtl`.

### 6.2 What resets the auto-stop timer [doc]

Resets it:
- Lifecycle state changes
- **Network requests through previews** (app, terminal on 22222 and noVNC all go through previews)
- **Active SSH connections**
- **Toolbox API requests** (file, git, process, PTY and computer-use calls)
- Explicit `refreshActivity()`

Does **not** reset it:
- Non-toolbox SDK and API calls (listing, getting info)
- Background processes such as `npm run dev` or a running `claude -p`
- Long tasks without external interaction

**Conflicting sources [UNVERIFIED]:**
- The SDK docstring on `setAutostopInterval` and the claude-toolsets README say preview interactions do **not** count.
- The docs page, the troubleshooting page, and the existence of the `X-Daytona-Skip-Last-Activity-Update` proxy header say they do.
- For auto-pause (VM), the docs say previews do **not** count.
- Whether a long-lived PTY WebSocket counts continuously or only per message/connect is undocumented.

Recommended pattern: **send a heartbeat from the Next.js server while a workspace tab is open or an agent turn is running.**

### 6.3 refreshActivity endpoint [spec]

`POST https://app.daytona.io/api/sandbox/{sandboxId}/last-activity`

- Auth: `Authorization: Bearer <API key>` (or OAuth JWT plus an `X-Daytona-Organization-ID` header).
- Optional body `{ "activityType": "toolbox" }`; returns 201.
- No specific scope is listed [UNVERIFIED whether a zero-scope key works; toolbox access needs none].
- `lastActivityAt` is returned on the sandbox DTO.

### 6.4 Events

- **Webhooks** [doc, docs:webhooks.md]:
  - Svix-backed, configured in the dashboard, and may need support to enable.
  - Events: `sandbox.created`, `sandbox.state.updated` (`oldState`/`newState`), `snapshot.created|state.updated|removed`, `volume.created|state.updated`.
  - Requires a public HTTPS endpoint. API: `/webhooks/organizations/{id}/initialize`, `/app-portal-access`.
- **No SSE or WebSocket event stream for lifecycle.** Poll instead with `GET /sandbox/{id}` or `GET /sandbox?labels=...` (each poll counts against the rate limits below).
- **Rate limits**: Tier 1 is 10k general requests/min, 300 creates/min, and 10k lifecycle calls/min. Tier 4 is 50k / 600 / 50k. Responses carry `X-RateLimit-*-{throttler}` headers.
- **Sandbox states**: creating, pulling_snapshot, building_snapshot, pending_build, build_failed, starting, started, stopping, stopped, pausing, paused, resuming, archiving, archived, restoring, resizing, snapshotting, forking, deleting, deleted, error (check `recoverable` and call `recover()`), unknown.

---

## 7. Limits

[doc, docs:limits.md, docs:sandboxes.md#resources]

**Per-sandbox maximum (org default): 4 vCPU, 8 GiB RAM, 10 GiB disk.** The defaults are 1 / 1 / 3. Raise the limit through support. **Resize** must also be enabled by support:
- CPU and RAM can go up while running.
- Lowering them, or raising disk, requires a stop.
- Disk can only grow.
- Inside the sandbox, read limits from `/sys/fs/cgroup/{cpu,memory}.max`, because `nproc` and `free` show host values.

Org compute pool by tier (concurrency is bounded only by the pool):

| Tier | vCPU / RAM / Storage | How to reach it |
|---|---|---|
| 1 | 10 / 10 GiB (the limits table says 20) / 30 GiB | Verify email |
| 2 | 100 / 200 / 300 | Link a card and top up $25 |
| 3 | 250 / 500 / 2000 | Top up $500 |
| 4 | 500 / 1000 / 5000 | Top up $2000 every 30 days |
| Custom | — | Contact sales |

- **What counts against the pool**: stopped, paused, archived and deleted sandboxes free their CPU and RAM. Stopped *containers* keep counting disk until archived.
- **What doesn't count**: volumes and GPU sandboxes.
- **Free credits**: $200 at signup; they don't apply to GPU.
- **Feature flags that need support**: warm pools, webhooks, resize, KVM.

---

## 8. Dev-environment and workspace features and Claude integrations worth reusing

- **The legacy devcontainer "workspaces" product is gone.**
  - The `legacy-daytona-provider-*` repos were archived in July 2026.
  - `github.com/daytona/daytona` returns 404 today, so the daemon and server source are not public. The SDKs, CLI and OpenAPI specs live in `daytona/clients`.
  - The current sandbox image is itself built on the devcontainers base.
- **`integrations/apps/opencode-workspaces-plugin`**: the closest "remote workspace" reference. It provisions a sandbox per workspace, uploads the repo at depth 1, starts the OpenCode server and exposes previews. It shows the shape, though it isn't Claude-specific.
- **`@daytona/claude-toolsets` (TypeScript and Python)**:
  - Ready-made `DaytonaComputer` (computer_toolset_20260801 over the Computer Use API) and `DaytonaBrowser` (browser_toolset_20260801 over CDP through a signed preview).
  - It includes activity refresh around calls and URL/file policies.
  - Reuse it for a "Claude drives the browser panel" feature.
- **Claude Code in a sandbox** [doc]:
  - It's preinstalled. The CLI guide is just `daytona ssh` and then `claude` (OAuth via copy/paste URL).
  - The SDK guide runs `claude --dangerously-skip-permissions -p ... --output-format stream-json --verbose` inside a PTY and streams `onData`. That is the obvious backend for a composer UI.
  - Note that the guide passes `ANTHROPIC_API_KEY` inline. Prefer a Secret.
- **Claude Managed Agents, self-hosted environment** [doc + guides/python/claude/claude-managed-agents]:
  - Anthropic runs the agent loop, and the Daytona sandbox runs the bash/read/write/edit/glob/grep tools through an in-sandbox `EnvironmentWorker`.
  - It offers a polling orchestrator (no public URL needed) and session metadata keys `daytona.sandbox_id` and `daytona.snapshot_name`.
  - This is an alternative to running the Claude Code CLI.
- **Claude Agent SDK guides**: `guides/typescript/anthropic/single-claude-agent-sdk` and `multi-agent-claude-sdk`.
- **Daytona agent skill / Claude Code plugin**: `claude plugin marketplace add daytona/skills && claude plugin install daytona@daytona`. **Daytona MCP server**: `daytona mcp init claude`. These help when developing the app itself.
- **SSH and IDE access**: `ssh <token>@ssh.app.daytona.io` works with VS Code Remote-SSH and JetBrains Gateway. That makes a cheap "open in IDE" button.

## Sources

- https://www.daytona.io/docs/en/sandboxes.md · snapshots.md · isolation.md · persistence.md · limits.md · billing.md · network-limits.md · secrets.md · audit-logs.md · preview.md · custom-preview-proxy.md · web-terminal.md · ssh-access.md · vnc-access.md · computer-use.md · git-operations.md · webhooks.md · regions.md · api-keys.md · architecture.md · warm-pools.md · volumes.md · troubleshooting.md · llms-full.txt
- https://www.daytona.io/pricing (fetched 2026-10-17)
- https://github.com/daytona/clients (`openapi-specs/{api,toolbox}.json`, `sdk-typescript/src/{Git,Sandbox,Process,ComputerUse}.ts`, `utils/WebSocket.ts`)
- https://github.com/daytona/integrations (`packages/claude-toolsets`, `apps/opencode-workspaces-plugin`)
- https://github.com/daytona/guides (`python/cognition/devin-outposts/.../Dockerfile.default`, `python/claude/claude-managed-agents`)
- Docker Hub `daytonaio/sandbox:0.10.0` image config/history (amd64)
- Local mirror: `/private/tmp/claude-501/-Users-zgrogan-Repos-codespace/cd6e3a1f-ba38-44c1-86cc-e0c9a4c4e29e/scratchpad/dt/`
