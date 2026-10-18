// End-to-end check against real Modal: boots a throwaway sandbox, sets it up like a
// workspace, runs one Claude turn through the remote transport, checks the terminal and
// desktop behind connect tokens, then snapshots, terminates and restores it.
// Every sandbox has a 20-minute hard timeout, so nothing outlives a crashed run for long.
// Usage: pnpm smoke            (SMOKE_GPU=T4 pnpm smoke also checks a GPU snapshot)
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Sandbox } from "modal";
import { modal, modalApp, run, BASE_IMAGE, WORKSPACE_ROOT, VNC_PORT, TERMINAL_PORT } from "../src/server/modal";
import { bootstrap } from "../src/server/workspaces";
import { spawnInSandbox } from "../src/server/transport";
import { getSecret } from "../src/server/secrets";

const step = (s: string) => console.log(`\n▶ ${s}`);
const TIMEOUT = 20 * 60_000;
const made: Sandbox[] = [];

async function create(image = modal().images.fromRegistry(BASE_IMAGE), gpu?: string) {
  const sb = await modal().sandboxes.create(await modalApp(), image, {
    cpu: 2,
    memoryMiB: 4096,
    gpu,
    timeoutMs: TIMEOUT,
    workdir: WORKSPACE_ROOT,
    tags: { app: "codespace", smoke: "1" },
  });
  made.push(sb);
  return sb;
}

/** Opens a websocket and reports whether the handshake succeeded. */
function wsOpens(url: string, protocol: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, [protocol]);
    const t = setTimeout(() => (ws.close(), resolve("timed out")), 10_000);
    ws.onopen = () => (clearTimeout(t), ws.close(), resolve("open"));
    ws.onerror = () => (clearTimeout(t), resolve("error"));
  });
}

async function main() {
  const token = getSecret("claude-oauth-token");
  if (!token) throw new Error("No Claude token in Keychain/env");

  step(`create sandbox from ${BASE_IMAGE}`);
  let t0 = Date.now();
  const sb = await create();
  console.log(`  ${sb.sandboxId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  step("bootstrap");
  await bootstrap(sb);
  console.log((await run(sb, `claude --version; gh --version | head -1; ttyd --version; free -m | head -2; df -h / | tail -1`)).output);

  step("claude turn over the Modal exec transport");
  const q = query({
    prompt: "Reply with exactly the word: pong",
    options: {
      cwd: WORKSPACE_ROOT,
      pathToClaudeCodeExecutable: "claude",
      env: {},
      maxTurns: 1,
      spawnClaudeCodeProcess: (o) => spawnInSandbox(sb, o, { CLAUDE_CODE_OAUTH_TOKEN: token }),
    },
  });
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") console.log(`  init: model=${m.model} session=${m.session_id}`);
    if (m.type === "result") console.log(`  result: ${m.subtype} ${"result" in m ? m.result : ""}`);
  }

  step("terminal (ttyd) behind a connect token");
  await run(sb, `nohup ttyd -p ${TERMINAL_PORT} -W bash >/tmp/ttyd.log 2>&1 & sleep 1`);
  const term = await sb.createConnectToken({ port: TERMINAL_PORT });
  const tq = `_modal_connect_token=${encodeURIComponent(term.token)}`;
  console.log(`  no token → HTTP ${(await fetch(term.url)).status}; with token → HTTP ${(await fetch(`${term.url}/?${tq}`)).status}`);
  console.log(`  websocket with token in query → ${await wsOpens(`${term.url.replace(/^http/, "ws")}/ws?${tq}`, "tty")}`);

  step("desktop (Xvfb + noVNC) behind a connect token");
  await run(
    sb,
    `(nohup Xvfb :0 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &); sleep 1; (DISPLAY=:0 nohup startxfce4 >/tmp/xfce.log 2>&1 &); (nohup x11vnc -display :0 -forever -nopw -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &); (nohup websockify --web /usr/share/novnc ${VNC_PORT} localhost:5900 >/tmp/ws.log 2>&1 &); sleep 3`,
  );
  const vnc = await sb.createConnectToken({ port: VNC_PORT });
  const vq = `_modal_connect_token=${encodeURIComponent(vnc.token)}`;
  console.log(`  vnc.html with token → HTTP ${(await fetch(`${vnc.url}/vnc.html?${vq}`)).status}`);
  console.log(`  websockify with token in query → ${await wsOpens(`${vnc.url.replace(/^http/, "ws")}/websockify?${vq}`, "binary")}`);

  step("snapshot, terminate, restore");
  await run(sb, `echo smoke-unpushed > ${WORKSPACE_ROOT}/smoke.txt`);
  t0 = Date.now();
  const image = await sb.snapshotFilesystem({ timeoutMs: 600_000 });
  console.log(`  snapshot ${image.imageId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sb.terminate();
  t0 = Date.now();
  const sb2 = await create(image);
  console.log(`  restored ${sb2.sandboxId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  file after restore: ${(await run(sb2, `cat ${WORKSPACE_ROOT}/smoke.txt; claude --version`)).output.trim()}`);

  const gpu = process.env.SMOKE_GPU;
  if (gpu) {
    step(`GPU (${gpu}): filesystem snapshot and restore`);
    const g = await create(modal().images.fromRegistry("debian:13-slim"), gpu);
    await run(g, `mkdir -p ${WORKSPACE_ROOT} && echo gpu-unpushed > ${WORKSPACE_ROOT}/g.txt`);
    const gimg = await g.snapshotFilesystem({ timeoutMs: 600_000 });
    await g.terminate();
    const g2 = await create(gimg, gpu);
    console.log(`  ${(await run(g2, `cat ${WORKSPACE_ROOT}/g.txt; nvidia-smi -L`)).output.trim()}`);
  }
}

main()
  .catch((e) => {
    console.error("\n✗", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    step("terminate sandboxes");
    for (const s of made) await s.terminate().catch(() => {});
    console.log(`  terminated ${made.length}`);
    process.exit();
  });
