import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex, type Readable, type Writable } from "node:stream";
import { Client, type ClientChannel } from "ssh2";
import { awsProfile, awsRegion } from "./aws/config";
import { sshPrivateKey } from "./aws/keys";

// CONTRACT FILE: the signatures below are shared by workspaces.ts, transport.ts, catalog.ts and
// threads.ts. Implemented as SSH (the ssh2 client) tunnelled through an AWS SSM session.

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

// ---- Local tooling ------------------------------------------------------------

// The Next server may be started with a minimal PATH (launchd, IDE), so look in the usual
// Homebrew locations too. The same PATH is handed to `aws`, which spawns the plugin itself.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/sessionmanagerplugin/bin"];

function searchPath(): string {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of EXTRA_PATH) if (!dirs.includes(d)) dirs.push(d);
  return dirs.join(path.delimiter);
}

function which(bin: string): string | null {
  for (const dir of searchPath().split(path.delimiter)) {
    const full = path.join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Whether the Session Manager plugin is installed (shown on the Settings page). */
export function hasSsmPlugin(): boolean {
  return which("session-manager-plugin") !== null;
}

function preflight(): string {
  const aws = which("aws");
  if (!aws) throw new Error("The AWS CLI v2 isn't installed (no `aws` on PATH). Install it with `brew install awscli`.");
  if (!hasSsmPlugin()) {
    throw new Error(
      "The AWS Session Manager plugin isn't installed (no `session-manager-plugin` on PATH). Install it with `brew install --cask session-manager-plugin`.",
    );
  }
  return aws;
}

// ---- Connection pool ------------------------------------------------------------

type Conn = { client: Client; child: ChildProcess };

const g = globalThis as unknown as {
  __csSsh?: Map<string, Promise<Conn>>;
  __csForwards?: Map<string, Promise<net.Server>>;
  /** Last local port per (instance, port), so a forward reopened after a stop keeps its URL. */
  __csForwardPorts?: Map<string, number>;
  __csRegions?: Map<string, string>;
};
const pool = (): Map<string, Promise<Conn>> => (g.__csSsh ??= new Map());
const forwards = (): Map<string, Promise<net.Server>> => (g.__csForwards ??= new Map());
const forwardPorts = (): Map<string, number> => (g.__csForwardPorts ??= new Map());
const regions = (): Map<string, string> => (g.__csRegions ??= new Map());

/** Records an instance's region, so it stays reachable after Settings switch to another region. */
export function setInstanceRegion(instanceId: string, region: string) {
  regions().set(instanceId, region);
}

/** The child's stdio as one socket for ssh2: its stdout is what we read, its stdin what we write. */
function childSocket(child: ChildProcess): Duplex {
  const out = child.stdout!;
  const inp = child.stdin!;
  const sock = new Duplex({
    read() {
      out.resume();
    },
    write(chunk, _enc, cb) {
      if (inp.destroyed) return cb(new Error("SSM session closed"));
      inp.write(chunk, (err) => cb(err ?? null));
    },
    final(cb) {
      inp.end();
      cb();
    },
    destroy(err, cb) {
      if (child.exitCode === null && !child.killed) child.kill();
      cb(err);
    },
  });
  out.on("data", (d: Buffer) => {
    if (!sock.push(d)) out.pause();
  });
  out.on("end", () => sock.push(null));
  out.on("error", (err) => sock.destroy(err));
  inp.on("error", (err) => sock.destroy(err));
  child.on("exit", () => sock.push(null));
  return sock;
}

function connect(instanceId: string): Promise<Conn> {
  const aws = preflight();
  const args = [
    "ssm",
    "start-session",
    "--target",
    instanceId,
    "--document-name",
    "AWS-StartSSHSession",
    "--parameters",
    "portNumber=22",
    "--region",
    regions().get(instanceId) ?? awsRegion(),
  ];
  const profile = awsProfile();
  if (profile) args.push("--profile", profile);

  const child = spawn(aws, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: searchPath() } });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  return new Promise<Conn>((resolve, reject) => {
    const client = new Client();
    let ready = false;
    const describe = (err: unknown) => {
      const base = err instanceof Error ? err.message : String(err);
      const tail = stderr.trim();
      if (/TargetNotConnected/.test(tail)) return new Error(`Instance ${instanceId} isn't reachable through SSM yet (TargetNotConnected).`);
      return new Error(tail ? `SSH over SSM to ${instanceId} failed: ${base}\n${tail}` : `SSH over SSM to ${instanceId} failed: ${base}`);
    };
    child.on("error", (err) => {
      if (!ready) reject(describe(err));
      client.end();
    });
    child.on("exit", () => {
      if (!ready) reject(describe("the SSM session ended before SSH was ready"));
      client.end();
    });
    client.on("ready", () => {
      ready = true;
      resolve({ client, child });
    });
    client.on("error", (err) => {
      if (!ready) reject(describe(err));
    });
    client.on("close", () => {
      if (child.exitCode === null && !child.killed) child.kill();
    });
    client.connect({
      sock: childSocket(child),
      username: "root",
      privateKey: sshPrivateKey(),
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      readyTimeout: 60_000,
      // Host key: accepted without checking. The byte stream is an SSM session that AWS has
      // already authenticated to this exact instance ID over TLS with our IAM identity, and
      // sshd only listens on the instance's loopback, so nothing else can sit on the other end.
      hostVerifier: () => true,
    });
  });
}

/** The live connection for an instance, sharing one in-flight connect between callers. */
function connection(instanceId: string): Promise<Conn> {
  const existing = pool().get(instanceId);
  if (existing) return existing;
  const p = connect(instanceId);
  pool().set(instanceId, p);
  const drop = () => {
    if (pool().get(instanceId) === p) pool().delete(instanceId);
  };
  p.then(
    ({ client, child }) => {
      client.once("close", drop);
      client.once("error", drop);
      child.once("exit", drop);
    },
    drop,
  );
  return p;
}

function signalCode(name: string | null | undefined): number {
  if (!name) return 255;
  const n = (os.constants.signals as Record<string, number>)[`SIG${name.replace(/^SIG/, "")}`];
  return n ? 128 + n : 255;
}

function openExec(client: Client, command: string, env: Record<string, string> | undefined): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    try {
      client.exec(command, env && Object.keys(env).length ? { env: env as NodeJS.ProcessEnv } : {}, (err, stream) => (err ? reject(err) : resolve(stream)));
    } catch (err) {
      reject(err);
    }
  });
}

async function execOn(instanceId: string, command: string, opts: Omit<ExecOptions, "timeout"> = {}): Promise<RemoteProcess> {
  const full = `bash -c ${q(`${PATH_PREFIX}; ${opts.cwd ? `cd ${q(opts.cwd)} && ` : ""}${command}`)}`;
  let stream: ClientChannel;
  const conn = await connection(instanceId);
  try {
    stream = await openExec(conn.client, full, opts.env);
  } catch {
    // A connection that died between pooling and use: drop it and try once on a fresh one.
    dropConnection(instanceId);
    stream = await openExec((await connection(instanceId)).client, full, opts.env);
  }

  let code: number | null = null;
  // Normally the exit message is followed promptly by EOF and close; wait for close so every
  // byte of output reaches readers first. If an orphaned child keeps the pipes (and so the
  // channel) open after the command itself exited, settle a moment after the exit message.
  const exited = new Promise<number>((resolve) => {
    stream.on("exit", (c: number | null, sig?: string) => {
      code = c ?? signalCode(sig);
      setTimeout(() => resolve(code ?? 255), 2_000).unref();
    });
    stream.on("close", () => resolve(code ?? 255));
  });
  stream.on("error", () => {});
  stream.stderr.on("error", () => {});

  return {
    stdin: stream,
    stdout: stream,
    stderr: stream.stderr,
    exited,
    // OpenSSH's sshd honours signal requests (since 7.9) but sends no reply, so this can't
    // tell whether it worked; callers that must be sure keep a pid-file fallback.
    async signal(sig: string) {
      try {
        stream.signal(sig.replace(/^SIG/, ""));
      } catch {}
    },
  };
}

function dropConnection(instanceId: string) {
  const p = pool().get(instanceId);
  pool().delete(instanceId);
  void p?.then(
    ({ client, child }) => {
      client.end();
      if (child.exitCode === null && !child.killed) child.kill();
    },
    () => {},
  );
}

function handle(instanceId: string): Remote {
  return { instanceId, exec: (command, opts) => execOn(instanceId, command, opts) };
}

// ---- Public API -------------------------------------------------------------------

/** The pooled connection for an instance, opening (or reopening) it as needed. */
export async function remote(instanceId: string): Promise<Remote> {
  await connection(instanceId);
  // Each exec re-acquires the pooled client, so the handle keeps working across reconnects.
  return handle(instanceId);
}

/** After boot or resume: retry until SSM and sshd answer, or throw after timeoutMs. */
export async function waitForRemote(instanceId: string, timeoutMs = 300_000): Promise<Remote> {
  const deadline = Date.now() + timeoutMs;
  let delay = 2_000;
  let last: unknown;
  for (;;) {
    try {
      const r = await remote(instanceId);
      const res = await run(r, "true", { timeout: 30 });
      if (res.exitCode === 0) return r;
      last = new Error(`probe exited ${res.exitCode}: ${res.output.slice(-500)}`);
      dropConnection(instanceId);
    } catch (err) {
      last = err;
    }
    if (Date.now() + delay > deadline) {
      const why = last instanceof Error ? last.message : String(last);
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${instanceId} to accept SSH over SSM. Last error: ${why}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10_000);
  }
}

/** Drop the pooled connection and any port forwards (instance stopped or gone). */
export function forgetRemote(instanceId: string): void {
  dropConnection(instanceId);
  for (const [key, server] of forwards()) {
    if (!key.startsWith(`${instanceId}:`)) continue;
    forwards().delete(key);
    void server.then((s) => s.close(), () => {});
  }
}

export async function run(r: Remote, command: string, opts: ExecOptions = {}): Promise<{ exitCode: number; output: string }> {
  const p = await r.exec(command, { cwd: opts.cwd, env: opts.env });
  p.stdin.end();
  let out = "";
  let err = "";
  p.stdout.on("data", (d: Buffer) => (out += d.toString()));
  p.stderr.on("data", (d: Buffer) => (err += d.toString()));
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      void p.signal("KILL");
      (p.stdin as ClientChannel).close?.();
    },
    (opts.timeout ?? 600) * 1000,
  );
  let exitCode = await p.exited;
  clearTimeout(timer);
  if (timedOut) {
    exitCode = 124;
    err += `\n[timed out after ${opts.timeout ?? 600}s]`;
  }
  return { exitCode, output: err && exitCode !== 0 ? `${out}${err}` : out };
}

export async function mustRun(r: Remote, command: string, opts: ExecOptions = {}): Promise<string> {
  const res = await run(r, command, opts);
  if (res.exitCode !== 0) throw new Error(`Command failed (${res.exitCode}): ${command}\n${res.output.slice(-2000)}`);
  return res.output;
}

/** Writes a file on the instance (creating its directory) by streaming it over the channel's stdin. */
export async function writeFile(r: Remote, file: string, data: Buffer | string): Promise<void> {
  const p = await r.exec(`mkdir -p ${q(path.posix.dirname(file))} && cat > ${q(file)}`);
  let err = "";
  p.stderr.on("data", (d: Buffer) => (err += d.toString()));
  p.stdout.resume();
  p.stdin.end(data);
  const code = await p.exited;
  if (code !== 0) throw new Error(`Writing ${file} failed (${code}): ${err.slice(-1000)}`);
}

/**
 * A local TCP port on 127.0.0.1 that tunnels to `remotePort` on the instance. Stable per
 * (instance, port) while the instance runs, so a URL handed to the browser keeps working.
 */
export async function forwardPort(instanceId: string, remotePort: number): Promise<number> {
  const key = `${instanceId}:${remotePort}`;
  let server = forwards().get(key);
  if (!server) {
    server = listen(instanceId, remotePort, forwardPorts().get(key) ?? 0);
    forwards().set(key, server);
    server.catch(() => {
      if (forwards().get(key) === server) forwards().delete(key);
    });
  }
  const port = (await server).address() as net.AddressInfo;
  forwardPorts().set(key, port.port);
  return port.port;
}

// The forwards reach a root shell (ttyd), the desktop and dev servers, and anything on this Mac
// can connect to 127.0.0.1. A browser is the realistic attacker: a hostile page can rebind its
// own hostname to 127.0.0.1, or open a WebSocket to 127.0.0.1 directly (WebSockets skip CORS),
// including a page served through another forward (a preview pulling in third-party scripts).
// So an HTTP request must name a loopback Host, and an Origin, when sent, must be this forward's
// own origin (ttyd's page talking to itself) or the app's (the noVNC client). Browsers can only
// speak HTTP, so other protocols pass; local processes already hold the SSH key and AWS creds.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HEAD_CAP = 16_384;

function hostPort(h: string): { host: string; port: string } {
  const m = h.trim().toLowerCase().match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/);
  return { host: m?.[1] ?? "", port: m?.[2] ?? "" };
}

function httpAllowed(head: string, localPort: number): boolean {
  const host = head.match(/\r\nhost:[ \t]*([^\r\n]*)/i)?.[1];
  if (host === undefined || !LOOPBACK.has(hostPort(host).host)) return false;
  const origin = head.match(/\r\norigin:[ \t]*([^\r\n]*)/i)?.[1]?.trim();
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const appPort = process.env.PORT ?? "4100"; // next dev/start set PORT to the port they serve on
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) && (u.port === String(localPort) || u.port === appPort);
  } catch {
    return false; // includes "null" (sandboxed frames, file: pages)
  }
}

const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: open this through the app on localhost.\n";

/**
 * Reads the start of a connection and lets it through (replaying those bytes) only if allowed.
 * Fails closed: anything that could still be an HTTP request line is buffered until the header
 * block ends, and a head that outgrows the cap is refused rather than judged on a fragment.
 */
function admit(sock: net.Socket, accept: () => void) {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const text = head.toString("latin1");
    const maybeHttp = /^[A-Z]{1,16}( |$)/.test(text);
    if (maybeHttp && !text.includes("\r\n\r\n")) {
      if (head.length > HEAD_CAP) {
        sock.off("data", onData);
        sock.end(FORBIDDEN);
      }
      return;
    }
    sock.off("data", onData);
    sock.pause();
    if (maybeHttp && !httpAllowed(text, sock.localPort ?? 0)) {
      sock.end(FORBIDDEN);
      return;
    }
    sock.unshift(head);
    accept();
  };
  sock.on("data", onData);
}

function listen(instanceId: string, remotePort: number, preferred: number): Promise<net.Server> {
  const make = () =>
    // allowHalfOpen: a client that half-closes (FIN) can still receive the rest of the reply.
    net.createServer({ allowHalfOpen: true }, (sock) => {
      sock.on("error", () => {});
      admit(sock, () => pipeTo(sock));
    });
  const pipeTo = (sock: net.Socket) => {
      sock.pause();
      // Re-acquire the pooled client per connection so the forward survives reconnects.
      connection(instanceId).then(
        ({ client }) => {
          try {
            client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, ch) => {
              if (err) return sock.destroy();
              ch.on("error", () => sock.destroy());
              ch.on("close", () => sock.destroy());
              sock.on("close", () => ch.close());
              sock.pipe(ch).pipe(sock);
              sock.resume();
            });
          } catch {
            sock.destroy();
          }
        },
        () => sock.destroy(),
      );
  };
  const tryPort = (port: number) =>
    new Promise<net.Server>((resolve, reject) => {
      const s = make();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => {
        s.off("error", reject);
        s.on("error", () => {});
        resolve(s);
      });
    });
  return preferred ? tryPort(preferred).catch(() => tryPort(0)) : tryPort(0);
}
