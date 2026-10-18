import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { WORKSPACE_ROOT, q, run, type Remote, type RemoteProcess } from "./remote";

// Env vars from the SDK that are meaningful on the instance. Everything else in the Mac's
// environment (PATH, HOME, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR...) stays local.
const FORWARD_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK", "MCP_", "DISABLE_"];
const NEVER_FORWARD = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"]);

/**
 * Runs the Claude Code CLI on a workspace instance and exposes it to the Agent SDK as a
 * local process: stdin/stdout are piped through an SSH exec channel. Env (including the
 * OAuth token) travels on the channel itself (sshd AcceptEnv), so it never lands in argv or
 * on the instance's disk.
 */
export function spawnRemote(r: Remote, opts: SpawnOptions, extraEnv: Record<string, string>): SpawnedProcess {
  return new RemoteClaude(r, opts, extraEnv);
}

class RemoteClaude extends EventEmitter implements SpawnedProcess {
  // Writes made before the channel opens buffer here and flow through in order once it does.
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  private proc: Promise<RemoteProcess>;
  // OpenSSH may ignore signal requests, so the shell also records its PID for kill().
  private pidFile = `/tmp/cs-${randomUUID()}.pid`;

  constructor(private r: Remote, opts: SpawnOptions, extraEnv: Record<string, string>) {
    super();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || NEVER_FORWARD.has(k)) continue;
      if (FORWARD_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
    }
    Object.assign(env, extraEnv);

    const cwd = opts.cwd ?? WORKSPACE_ROOT;
    const command = `echo $$ > ${this.pidFile}; mkdir -p ${q(cwd)} && cd ${q(cwd)} && exec claude ${opts.args.map(q).join(" ")}`;
    this.proc = r.exec(command, { env });

    void this.proc
      .then(async (p) => {
        this.stdin.pipe(p.stdin);
        p.stdin.on("error", () => {});
        p.stderr.on("data", (c: Buffer) => process.stderr.write(`[claude ${this.pidFile}] ${c}`));
        p.stdout.pipe(this.stdout, { end: false });
        this.finish(await p.exited);
      })
      .catch((err) => this.fail(err));

    opts.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
  }

  private finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = this.killed && code === 0 ? 143 : code;
    this.stdout.end();
    this.emit("exit", this.exitCode, this.killed ? "SIGTERM" : null);
    void run(this.r, `rm -f ${this.pidFile}`).catch(() => {});
  }

  private fail(err: unknown) {
    if (this.exitCode !== null) return;
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
    this.finish(1);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed || this.exitCode !== null) return false;
    this.killed = true;
    const sig = signal.replace(/^SIG/, "");
    void (async () => {
      // First the SSH signal request; if the process is still there a second later, the PID file.
      await this.proc.then((p) => p.signal(sig)).catch(() => {});
      await new Promise((res) => setTimeout(res, 1000));
      if (this.exitCode !== null) return;
      await run(this.r, `test -f ${this.pidFile} && kill -${sig} "$(cat ${this.pidFile})"`, { timeout: 30 });
    })()
      .catch(() => {})
      .finally(() => setTimeout(() => this.finish(143), 5000));
    return true;
  }
}
