import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "modal";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { PATH_PREFIX, WORKSPACE_ROOT, q, run } from "./modal";

// Env vars from the SDK that are meaningful inside the sandbox. Everything else in
// the Mac's environment (PATH, HOME, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR...) stays local.
const FORWARD_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK", "MCP_", "DISABLE_"];
const NEVER_FORWARD = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"]);

/**
 * Runs the Claude Code CLI inside a Modal sandbox and exposes it to the Agent SDK
 * as a local process: stdin/stdout are piped through a Modal exec. Env (including the
 * OAuth token) is passed on the exec call itself, so it never lands on the sandbox's disk.
 */
export function spawnInSandbox(sb: Sandbox, opts: SpawnOptions, extraEnv: Record<string, string>): SpawnedProcess {
  return new RemoteProcess(sb, opts, extraEnv);
}

class RemoteProcess extends EventEmitter implements SpawnedProcess {
  stdin: Writable;
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  // Modal execs can't be signalled, so the shell records its PID for kill().
  private pidFile = `/tmp/cs-${randomUUID()}.pid`;

  constructor(private sb: Sandbox, opts: SpawnOptions, extraEnv: Record<string, string>) {
    super();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || NEVER_FORWARD.has(k)) continue;
      if (FORWARD_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
    }
    Object.assign(env, extraEnv);

    const cwd = opts.cwd ?? WORKSPACE_ROOT;
    const command = `${PATH_PREFIX}; echo $$ > ${this.pidFile}; mkdir -p ${q(cwd)} && cd ${q(cwd)} && exec claude ${opts.args.map(q).join(" ")}`;
    const proc = sb.exec(["bash", "-c", command], { env });

    const writer = proc.then((p) => p.stdin.getWriter());
    let chain: Promise<unknown> = writer;
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        chain = chain.then(async () => (await writer).write(chunk.toString()));
        chain.then(() => cb(), (err) => cb(err as Error));
      },
      final: (cb) => {
        void writer.then((w) => w.close()).then(() => cb(), () => cb());
      },
    });

    void proc
      .then(async (p) => {
        void (async () => {
          for await (const c of p.stderr as unknown as AsyncIterable<string>) process.stderr.write(`[claude ${this.pidFile}] ${c}`);
        })().catch(() => {});
        for await (const c of p.stdout as unknown as AsyncIterable<string>) this.stdout.write(c);
        this.finish(await p.wait());
      })
      .catch((err) => this.fail(err));

    opts.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
  }

  private finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = this.killed && code === 0 ? 143 : code;
    this.stdout.end();
    this.emit("exit", this.exitCode, this.killed ? "SIGTERM" : null);
    void run(this.sb, `rm -f ${this.pidFile}`).catch(() => {});
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
    void run(this.sb, `test -f ${this.pidFile} && kill -${sig} "$(cat ${this.pidFile})"`)
      .catch(() => {})
      .finally(() => setTimeout(() => this.finish(143), 5000));
    return true;
  }
}
