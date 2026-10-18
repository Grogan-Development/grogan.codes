import { ModalClient, type App, type Sandbox } from "modal";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSecret } from "./secrets";

export const HOME = "/root";
export const WORKSPACE_ROOT = `${HOME}/workspace`;
export const TERMINAL_PORT = 7681;
export const VNC_PORT = 6080;

/** Base image for new workspaces: ships Claude Code, node, git, Xvfb, noVNC and Chromium. */
export const BASE_IMAGE = process.env.CODESPACE_IMAGE ?? "daytonaio/sandbox:0.10.0";
const APP_NAME = "codespace";
/** Modal's hard cap on a sandbox's lifetime. The idle reaper snapshots well before it. */
export const MAX_LIFETIME_MS = 24 * 60 * 60_000;

// A login shell in the base image prints terminal-title escapes on stdout, which corrupts
// command output and Claude's JSON stream, so commands run in plain bash with this PATH.
export const PATH_PREFIX = `export PATH="/usr/local/share/nvm/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`;

const g = globalThis as unknown as { __csModal?: ModalClient; __csApp?: Promise<App>; __csSandboxes?: Map<string, Sandbox> };

/** Credentials come from the Keychain or env, else the Modal CLI's ~/.modal.toml. */
export function hasModalCredentials(): boolean {
  return !!(getSecret("modal-token-id") && getSecret("modal-token-secret")) || existsSync(path.join(os.homedir(), ".modal.toml"));
}

export function modal(): ModalClient {
  if (!g.__csModal) {
    if (!hasModalCredentials()) throw new Error("No Modal token. Add one in Settings.");
    const tokenId = getSecret("modal-token-id");
    const tokenSecret = getSecret("modal-token-secret");
    g.__csModal = tokenId && tokenSecret ? new ModalClient({ tokenId, tokenSecret }) : new ModalClient();
  }
  return g.__csModal;
}

export function modalApp(): Promise<App> {
  g.__csApp ??= modal().apps.fromName(APP_NAME, { createIfMissing: true });
  g.__csApp.catch(() => (g.__csApp = undefined));
  return g.__csApp;
}

export function resetModal() {
  g.__csModal = undefined;
  g.__csApp = undefined;
  g.__csSandboxes = undefined;
}

export async function sandbox(sandboxId: string, fresh = false): Promise<Sandbox> {
  g.__csSandboxes ??= new Map();
  const cached = g.__csSandboxes.get(sandboxId);
  if (cached && !fresh) return cached;
  const sb = await modal().sandboxes.fromId(sandboxId);
  g.__csSandboxes.set(sandboxId, sb);
  return sb;
}

export function forgetSandbox(sandboxId: string) {
  g.__csSandboxes?.delete(sandboxId);
}

/** Shell-quote a single argument. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function run(sb: Sandbox, command: string, opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}) {
  const p = await sb.exec(["bash", "-c", `${PATH_PREFIX}; ${command}`], {
    workdir: opts.cwd,
    env: opts.env,
    timeoutMs: (opts.timeout ?? 600) * 1000,
  });
  const [out, err, exitCode] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
  return { exitCode, output: err && exitCode !== 0 ? `${out}${err}` : out };
}

export async function mustRun(sb: Sandbox, command: string, opts: Parameters<typeof run>[2] = {}) {
  const res = await run(sb, command, opts);
  if (res.exitCode !== 0) throw new Error(`Command failed (${res.exitCode}): ${command}\n${res.output.slice(-2000)}`);
  return res.output;
}
