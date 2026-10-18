// End-to-end check against real AWS: launches a throwaway instance from the infra/ stack's
// launch template, sets it up like a workspace, runs one Claude turn over SSH-over-SSM, checks
// the terminal and desktop through local port forwards, then hibernates, starts and checks a
// file survived. The instance is terminated (and its spot request cancelled) in `finally`.
// Costs money. Usage: pnpm smoke   (SMOKE_SPOT=1 for spot, SMOKE_TYPE=m8g.large to override)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { awsRegion } from "../src/server/aws/config";
import { machine, machineLabel } from "../src/server/aws/machines";
import { launchInstance, startInstance, stopInstance, terminateInstance, waitForState, describeInstance } from "../src/server/aws/ec2";
import { waitForRemote, forgetRemote, forwardPort, run, WORKSPACE_ROOT, VNC_PORT, TERMINAL_PORT } from "../src/server/remote";
import { bootstrap } from "../src/server/workspaces";
import { spawnRemote } from "../src/server/transport";
import { getSecret } from "../src/server/secrets";

const step = (s: string) => console.log(`\n▶ ${s}`);
const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let instanceId: string | null = null;

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
  const region = awsRegion();
  const m = machine(process.env.SMOKE_TYPE || "t4g.medium");
  const market = process.env.SMOKE_SPOT === "1" ? "spot" : "on-demand";

  step(`launch ${machineLabel(m)} (${market}) in ${region}`);
  let t0 = Date.now();
  const l = await launchInstance({ workspaceId: `smoke-${Date.now().toString(36)}`, machine: m, market, diskGb: 30, region });
  instanceId = l.instanceId;
  console.log(`  ${l.instanceId} in ${l.az}, ${l.volumeGb} GiB root, hibernate=${l.hibernate}`);
  await waitForState(l.instanceId, "running", { region });
  console.log(`  running after ${secs(t0)}`);
  let r = await waitForRemote(l.instanceId);
  console.log(`  ssh over SSM after ${secs(t0)}`);

  step("bootstrap");
  t0 = Date.now();
  await bootstrap(r);
  console.log(`  ${secs(t0)}`);
  console.log((await run(r, `claude --version; gh --version | head -1; ttyd --version; free -m | head -2; df -h / | tail -1`)).output);

  step("claude turn over the SSH transport");
  const q = query({
    prompt: "Reply with exactly the word: pong",
    options: {
      cwd: WORKSPACE_ROOT,
      pathToClaudeCodeExecutable: "claude",
      env: {},
      maxTurns: 1,
      spawnClaudeCodeProcess: (o) => spawnRemote(r, o, { CLAUDE_CODE_OAUTH_TOKEN: token }),
    },
  });
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") console.log(`  init: model=${msg.model} session=${msg.session_id}`);
    if (msg.type === "result") console.log(`  result: ${msg.subtype} ${"result" in msg ? msg.result : ""}`);
  }

  step("terminal (ttyd) through a port forward");
  await run(r, `nohup ttyd -p ${TERMINAL_PORT} -W bash >/tmp/ttyd.log 2>&1 & sleep 1`);
  const tp = await forwardPort(l.instanceId, TERMINAL_PORT);
  console.log(`  http://127.0.0.1:${tp}/ → HTTP ${(await fetch(`http://127.0.0.1:${tp}/`)).status}`);
  console.log(`  websocket → ${await wsOpens(`ws://127.0.0.1:${tp}/ws`, "tty")}`);

  step("desktop (Xvfb + websockify) through a port forward");
  await run(
    r,
    `(nohup Xvfb :0 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &); sleep 1; (DISPLAY=:0 nohup startxfce4 >/tmp/xfce.log 2>&1 &); (nohup x11vnc -display :0 -forever -nopw -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &); (nohup websockify --web /usr/share/novnc ${VNC_PORT} localhost:5900 >/tmp/ws.log 2>&1 &); sleep 3`,
  );
  const vp = await forwardPort(l.instanceId, VNC_PORT);
  console.log(`  vnc.html → HTTP ${(await fetch(`http://127.0.0.1:${vp}/vnc.html`)).status}`);
  console.log(`  websockify → ${await wsOpens(`ws://127.0.0.1:${vp}/websockify`, "binary")}`);

  step(l.hibernate ? "hibernate, start, check files and RAM survived" : "stop, start, check files survived");
  await run(r, `echo smoke-unpushed > ${WORKSPACE_ROOT}/smoke.txt; (nohup sleep 86400 >/dev/null 2>&1 &)`);
  // Hibernation needs the agent to have prepared swap, which takes a couple of minutes after boot.
  if (l.hibernate) await new Promise((res) => setTimeout(res, 120_000));
  forgetRemote(l.instanceId);
  t0 = Date.now();
  await stopInstance(l.instanceId, { hibernate: true }, region);
  const stopped = await waitForState(l.instanceId, "stopped", { region });
  console.log(`  stopped in ${secs(t0)} (${stopped.stateReason})`);
  t0 = Date.now();
  await startInstance(l.instanceId, region);
  await waitForState(l.instanceId, "running", { region });
  r = await waitForRemote(l.instanceId);
  console.log(`  back in ${secs(t0)}`);
  console.log(`  file: ${(await run(r, `cat ${WORKSPACE_ROOT}/smoke.txt`)).output.trim()}`);
  console.log(`  sleep process survived: ${(await run(r, `pgrep -x sleep >/dev/null && echo yes || echo no`)).output.trim()}`);
  console.log(`  instance: ${JSON.stringify(await describeInstance(l.instanceId, region))}`);
}

main()
  .catch((e) => {
    console.error("\n✗", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (instanceId) {
      step(`terminate ${instanceId}`);
      forgetRemote(instanceId);
      await terminateInstance(instanceId, awsRegion()).then(
        () => console.log("  terminated (spot request cancelled if any)"),
        (err) => console.error(`  ✗ terminate failed, clean up ${instanceId} by hand:`, err),
      );
    }
    process.exit();
  });
