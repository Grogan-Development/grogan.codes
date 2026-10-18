import type { Readable, Writable } from "node:stream";

// CONTRACT FILE: the signatures below are shared by workspaces.ts, transport.ts, catalog.ts and
// threads.ts. Implementations are filled in by the SSH-over-SSM work; keep the signatures.

/** Workspaces run as root on the instance, the same layout the Modal sandboxes used. */
export const HOME = "/root";
export const WORKSPACE_ROOT = `${HOME}/workspace`;
export const TERMINAL_PORT = 7681;
export const VNC_PORT = 6080;

// Commands run in plain bash (not a login shell) with this PATH. The AMI installs Node and
// tools under /usr/local/bin and Claude Code under /root/.local/bin.
export const PATH_PREFIX = `export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`;

/** Shell-quote a single argument. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type ExecOptions = { cwd?: string; env?: Record<string, string>; timeout?: number /* seconds */ };

/** A command running on the instance, with live pipes. */
export interface RemoteProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Resolves with the exit code (128+n for a signal) once the command ends or the channel drops. */
  exited: Promise<number>;
  /** Best-effort signal ("TERM", "KILL", "INT") to the command's process. */
  signal(sig: string): Promise<void>;
}

/** One SSH-over-SSM connection to a running instance, shared by every caller. */
export interface Remote {
  readonly instanceId: string;
  /** Runs `bash -c "<PATH_PREFIX>; <command>"`. Env travels on the SSH channel, never argv or disk. */
  exec(command: string, opts?: Omit<ExecOptions, "timeout">): Promise<RemoteProcess>;
}

/** The pooled connection for an instance, opening (or reopening) it as needed. */
export async function remote(instanceId: string): Promise<Remote> {
  void instanceId;
  throw new Error("not implemented");
}

/** After boot or resume: retry until SSM and sshd answer, or throw after timeoutMs. */
export async function waitForRemote(instanceId: string, timeoutMs = 300_000): Promise<Remote> {
  void instanceId;
  void timeoutMs;
  throw new Error("not implemented");
}

/** Drop the pooled connection and any port forwards (instance stopped or gone). */
export function forgetRemote(instanceId: string): void {
  void instanceId;
}

export async function run(r: Remote, command: string, opts: ExecOptions = {}): Promise<{ exitCode: number; output: string }> {
  void r;
  void command;
  void opts;
  throw new Error("not implemented");
}

export async function mustRun(r: Remote, command: string, opts: ExecOptions = {}): Promise<string> {
  const res = await run(r, command, opts);
  if (res.exitCode !== 0) throw new Error(`Command failed (${res.exitCode}): ${command}\n${res.output.slice(-2000)}`);
  return res.output;
}

/**
 * A local TCP port on 127.0.0.1 that tunnels to `remotePort` on the instance. Stable per
 * (instance, port) while the instance runs, so a URL handed to the browser keeps working.
 */
export async function forwardPort(instanceId: string, remotePort: number): Promise<number> {
  void instanceId;
  void remotePort;
  throw new Error("not implemented");
}
