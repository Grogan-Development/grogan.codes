import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { db } from "./db";
import { HOME, q, type Remote } from "./remote";

export type Kind = "plugin" | "mcp" | "skill" | "agent" | "command" | "workflow" | "memory";

export type CatalogItem = {
  id: string;
  kind: Kind;
  name: string;
  description: string | null;
  data: string;
  remote_ok: number;
};

type PluginData = { plugin: string; marketplace: string; source: Record<string, string> };
type FileData = { files: { rel: string; content: string }[] };

const CLAUDE_DIR = path.join(os.homedir(), ".claude");

export function listCatalog(): CatalogItem[] {
  return db().prepare("SELECT * FROM catalog_items ORDER BY kind, name").all() as CatalogItem[];
}

function upsert(kind: Kind, name: string, description: string | null, data: unknown, remoteOk = true) {
  const id = `${kind}:${name}`;
  db()
    .prepare(
      `INSERT INTO catalog_items (id, kind, name, description, data, remote_ok) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description, data = excluded.data, remote_ok = excluded.remote_ok`,
    )
    .run(id, kind, name, description, JSON.stringify(data), remoteOk ? 1 : 0);
}

export function addMcpServer(name: string, config: McpServerConfig) {
  upsert("mcp", name, (config as { command?: string; url?: string }).command ?? (config as { url?: string }).url ?? null, config);
}

export function removeCatalogItem(id: string) {
  db().prepare("DELETE FROM catalog_items WHERE id = ?").run(id);
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function frontmatterDescription(md: string): string | null {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const d = m?.[1].match(/^description:\s*(.+)$/m);
  return d ? d[1].replace(/^["']|["']$/g, "").slice(0, 200) : null;
}

function readTree(dir: string, base = dir): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".git")) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...readTree(full, base));
    else if (st.size < 2_000_000) out.push({ rel: path.relative(base, full), content: readFileSync(full).toString("base64") });
  }
  return out;
}

/** Import everything portable from the local ~/.claude into the catalog. */
export function importLocal() {
  const settings = readJson(path.join(CLAUDE_DIR, "settings.json"));
  const marketplaces = readJson(path.join(CLAUDE_DIR, "plugins", "known_marketplaces.json")) as Record<
    string,
    { source: Record<string, string> }
  >;
  const enabled = Object.keys((settings.enabledPlugins as Record<string, boolean>) ?? {});
  const installed = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, unknown>;
  };
  const pluginIds = new Set([...enabled, ...Object.keys(installed.plugins ?? {})]);
  for (const id of pluginIds) {
    const [plugin, marketplace] = id.split("@");
    const source = marketplaces[marketplace]?.source ?? {};
    const remoteOk = source.source === "github" || source.source === "git" || source.source === "url";
    upsert("plugin", id, remoteOk ? `from ${marketplace}` : `local marketplace ${marketplace} (not installable remotely)`, {
      plugin,
      marketplace,
      source,
    } satisfies PluginData, remoteOk);
  }

  const claudeJson = readJson(path.join(os.homedir(), ".claude.json"));
  for (const [name, cfg] of Object.entries((claudeJson.mcpServers as Record<string, McpServerConfig>) ?? {})) {
    addMcpServer(name, cfg);
  }

  const skillsDir = path.join(CLAUDE_DIR, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const dir = path.join(skillsDir, name);
      const skillMd = path.join(dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      upsert("skill", name, frontmatterDescription(readFileSync(skillMd, "utf8")), { files: readTree(dir) } satisfies FileData);
    }
  }

  for (const [kind, sub] of [
    ["agent", "agents"],
    ["command", "commands"],
    ["workflow", "workflows"],
  ] as const) {
    const dir = path.join(CLAUDE_DIR, sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const full = path.join(dir, file);
      if (!statSync(full).isFile()) continue;
      const content = readFileSync(full);
      upsert(kind, file.replace(/\.(md|js|ts)$/, ""), frontmatterDescription(content.toString("utf8")), {
        files: [{ rel: file, content: content.toString("base64") }],
      } satisfies FileData);
    }
  }

  const memory = path.join(CLAUDE_DIR, "CLAUDE.md");
  if (existsSync(memory)) {
    upsert("memory", "CLAUDE.md", "your global instructions", {
      files: [{ rel: "CLAUDE.md", content: readFileSync(memory).toString("base64") }],
    } satisfies FileData);
  }
}

// ---- Presets ----------------------------------------------------------------

export type Preset = { id: string; name: string; items: string };

export function listPresets(): Preset[] {
  return db().prepare("SELECT * FROM presets ORDER BY name").all() as Preset[];
}

export function savePreset(name: string, items: string[]) {
  db()
    .prepare("INSERT INTO presets (id, name, items) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET items = excluded.items")
    .run(name.toLowerCase().replace(/\W+/g, "-"), name, JSON.stringify(items));
}

export function deletePreset(id: string) {
  db().prepare("DELETE FROM presets WHERE id = ?").run(id);
}

// ---- Global instructions --------------------------------------------------------
// App-wide text written into every workspace's ~/.claude/CLAUDE.md. The shipped default lives
// in src/server/default-instructions.md; the user's override is a row in `settings`.

const INSTRUCTIONS_KEY = "global-instructions";
const DEFAULT_INSTRUCTIONS_FILE = path.join(process.cwd(), "src", "server", "default-instructions.md");
const g = globalThis as unknown as { __csSettingsTable?: boolean };

function settingsDb() {
  const d = db();
  if (!g.__csSettingsTable) {
    d.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    g.__csSettingsTable = true;
  }
  return d;
}

export function defaultInstructions(): string {
  try {
    return readFileSync(DEFAULT_INSTRUCTIONS_FILE, "utf8");
  } catch {
    return "";
  }
}

export function getInstructions(): { text: string; isDefault: boolean; defaultText: string } {
  const defaultText = defaultInstructions();
  const row = settingsDb().prepare("SELECT value FROM settings WHERE key = ?").get(INSTRUCTIONS_KEY) as { value: string } | undefined;
  return row ? { text: row.value, isDefault: false, defaultText } : { text: defaultText, isDefault: true, defaultText };
}

/** null or blank resets to the shipped default. */
export function setInstructions(text: string | null) {
  if (text === null || text.trim() === "") {
    settingsDb().prepare("DELETE FROM settings WHERE key = ?").run(INSTRUCTIONS_KEY);
  } else {
    settingsDb()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(INSTRUCTIONS_KEY, text);
  }
}

/** What new workspaces get when no loadout is given: every item that can be installed remotely. */
export function defaultLoadout(): string[] {
  if (listCatalog().length === 0) importLocal();
  return listCatalog()
    .filter((i) => i.remote_ok === 1)
    .map((i) => i.id);
}

// ---- Applying a loadout -------------------------------------------------------

function selected(loadout: string[]): CatalogItem[] {
  const all = new Map(listCatalog().map((i) => [i.id, i]));
  return loadout.map((id) => all.get(id)).filter((i): i is CatalogItem => !!i && i.remote_ok === 1);
}

export function loadoutHash(loadout: string[]) {
  const items = selected(loadout);
  return createHash("sha256")
    .update(JSON.stringify([getInstructions().text, items.map((i) => [i.id, i.data])]))
    .digest("hex")
    .slice(0, 16);
}

/** MCP servers are handed to the SDK per thread rather than written onto the instance. */
export function loadoutMcpServers(loadout: string[]): Record<string, McpServerConfig> {
  return Object.fromEntries(selected(loadout).filter((i) => i.kind === "mcp").map((i) => [i.name, JSON.parse(i.data)]));
}

const DEST: Record<Exclude<Kind, "plugin" | "mcp">, (name: string) => string> = {
  skill: (name) => `${HOME}/.claude/skills/${name}`,
  agent: () => `${HOME}/.claude/agents`,
  command: () => `${HOME}/.claude/commands`,
  workflow: () => `${HOME}/.claude/workflows`,
  memory: () => `${HOME}/.claude`,
};

const MANIFEST = `${HOME}/.claude/.codespace-manifest.json`;
const CLAUDE_MD = `${HOME}/.claude/CLAUDE.md`;

/** Global instructions, then the imported personal CLAUDE.md (if selected) under its own heading. */
function claudeMd(items: CatalogItem[]): string {
  const global = getInstructions().text.trim();
  const memory = items.find((i) => i.kind === "memory" && i.name === "CLAUDE.md");
  const file = memory && (JSON.parse(memory.data) as FileData).files.find((f) => f.rel === "CLAUDE.md");
  const personal = file ? Buffer.from(file.content, "base64").toString("utf8").trim() : "";
  if (!personal) return global;
  return `${global}\n\n# Personal instructions\n\n${personal}`.trimStart();
}

// ---- Tar ------------------------------------------------------------------------
// All placed files go up as one ustar stream on one exec, rather than one exec per file.

/** ustar fits a path as name (100 bytes), or prefix (155) + "/" + name split at a slash; else null. */
function ustarName(name: string): [prefix: string, base: string] | null {
  if (Buffer.byteLength(name) <= 100) return ["", name];
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) return [name.slice(0, i), name.slice(i + 1)];
  }
  return null;
}

function tarHeader(name: string, size: number, type: "0" | "x", mtime: number): Buffer {
  const h = Buffer.alloc(512);
  // A name that doesn't fit is preceded by a PAX header carrying the full path.
  const [prefix, base] = ustarName(name) ?? ["", name];
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  h.write(base, 0, 100);
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tar(files: { name: string; data: Buffer }[]): Buffer {
  const out: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
  const entry = (name: string, data: Buffer, type: "0" | "x") => {
    out.push(tarHeader(name, data.length, type, mtime), data, pad(data.length));
  };
  for (const f of files) {
    if (!ustarName(f.name)) {
      // PAX record "<len> path=<name>\n", where <len> counts its own digits.
      const body = ` path=${f.name}\n`;
      let len = Buffer.byteLength(body) + 1;
      while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
      entry("PaxHeader", Buffer.from(`${len}${body}`), "x");
    }
    entry(f.name, f.data, "0");
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

/** Runs a script on the instance, handing each output line to `log` as it arrives. */
async function runScript(r: Remote, script: string, log: (line: string) => void, stdin?: Buffer): Promise<number> {
  const p = await r.exec(script);
  let buf = "";
  const onData = (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) log(l);
  };
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.stdin.end(stdin);
  const code = await p.exited;
  if (buf.trim()) log(buf);
  return code;
}

/**
 * Make the instance's ~/.claude match the loadout: files we placed before but that are
 * no longer selected are removed; files the user created on the instance are untouched.
 * Files go up in one tar stream; plugins install from one script, in parallel.
 */
export async function applyLoadout(r: Remote, loadout: string[], log: (line: string) => void = () => {}) {
  const t0 = Date.now();
  const items = selected(loadout);
  const root = `${HOME}/.claude/`;
  const files: { name: string; data: Buffer }[] = [];
  const placed: string[] = [];
  const place = (target: string, data: Buffer) => {
    const rel = target.slice(root.length);
    if (!target.startsWith(root) || rel.split("/").includes("..")) return;
    files.push({ name: rel, data });
    placed.push(target);
  };

  for (const item of items) {
    if (item.kind === "plugin" || item.kind === "mcp") continue;
    // The personal CLAUDE.md is merged into ~/.claude/CLAUDE.md below, never written on its own.
    if (item.kind === "memory" && item.name === "CLAUDE.md") continue;
    const { files: itemFiles } = JSON.parse(item.data) as FileData;
    const dest = DEST[item.kind](item.name);
    for (const f of itemFiles) place(`${dest}/${f.rel}`, Buffer.from(f.content, "base64"));
  }
  const md = claudeMd(items);
  if (md) place(CLAUDE_MD, Buffer.from(`${md}\n`));
  files.push({ name: MANIFEST.slice(root.length), data: Buffer.from(JSON.stringify(placed)) });

  // Extract, then remove whatever the previous manifest listed that this one doesn't.
  const m = q(MANIFEST.slice(root.length));
  const filesScript = [
    `mkdir -p ~/.claude && cd ~/.claude || exit 1`,
    `old=$(cat ${m} 2>/dev/null || echo '[]')`,
    `tar -x --no-same-owner -m -f - || exit 1`,
    // Manifest entries are absolute; remove them relative to ~/.claude, never outside it.
    `rel() { jq -r --arg root ${q(root)} '.[] | select(startswith($root)) | ltrimstr($root) | select(split("/") | index("..") | not)'; }`,
    `rel <<<"$old" 2>/dev/null | grep -vxF -f <(rel < ${m}) | while IFS= read -r f; do rm -f -- "$f" && echo "removed $f"; done`,
    `true`,
  ].join("\n");
  const code = await runScript(r, filesScript, log, tar(files));
  if (code !== 0) throw new Error(`Placing loadout files failed (${code})`);
  log(`placed ${placed.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const plugins = items.filter((i) => i.kind === "plugin").map((i) => JSON.parse(i.data) as PluginData);
  const marketplaces = [...new Map(plugins.map((p) => [p.marketplace, p.source.repo ?? p.source.url])).entries()].filter(
    (e): e is [string, string] => !!e[1],
  );
  const wanted = [...new Set(plugins.map((p) => `${p.plugin}@${p.marketplace}`))];
  // Parallel CLI calls can race on Claude's JSON config files, so each phase re-checks and
  // retries what's still missing one at a time.
  const pluginScript = String.raw`
set +e
listed() { claude plugin list --json 2>/dev/null | jq -r '.[] | (.id // .name // empty)' 2>/dev/null; }
installed=$(listed)
mks=$(claude plugin marketplace list 2>/dev/null)
has_mk() { grep -qF -- "$1" <<<"$mks"; }
add_mk() { if out=$(claude plugin marketplace add "$2" 2>&1); then echo "marketplace $1: added"; else echo "marketplace $1: FAILED $(tail -c 300 <<<"$out" | tr '\n' ' ')"; fi; }
install() { if out=$(claude plugin install "$1" 2>&1); then echo "plugin $1: installed"; else echo "plugin $1: FAILED $(tail -c 300 <<<"$out" | tr '\n' ' ')"; fi; }
export -f install
MKS=(${marketplaces.map(([n, ref]) => `${q(n)} ${q(ref)}`).join(" ")})
WANTED=(${wanted.map(q).join(" ")})
missing_mks=()
for ((i = 0; i < ${"$"}{#MKS[@]}; i += 2)); do has_mk "${"$"}{MKS[i]}" || missing_mks+=("${"$"}{MKS[i]}" "${"$"}{MKS[i+1]}"); done
for ((i = 0; i < ${"$"}{#missing_mks[@]}; i += 2)); do add_mk "${"$"}{missing_mks[i]}" "${"$"}{missing_mks[i+1]}" > /dev/null & done
wait
mks=$(claude plugin marketplace list 2>/dev/null)
for ((i = 0; i < ${"$"}{#missing_mks[@]}; i += 2)); do
  if has_mk "${"$"}{missing_mks[i]}"; then echo "marketplace ${"$"}{missing_mks[i]}: added"; else add_mk "${"$"}{missing_mks[i]}" "${"$"}{missing_mks[i+1]}"; fi
done
todo=()
for id in "${"$"}{WANTED[@]}"; do grep -qxF -- "$id" <<<"$installed" || todo+=("$id"); done
echo "plugins: ${"$"}{#WANTED[@]} wanted, ${"$"}{#todo[@]} to install"
if ((${"$"}{#todo[@]})); then
  printf '%s\n' "${"$"}{todo[@]}" | xargs -P 6 -I{} bash -c 'install "$1" > /dev/null' _ {}
  now=$(listed)
  for id in "${"$"}{todo[@]}"; do
    if grep -qxF -- "$id" <<<"$now"; then echo "plugin $id: installed"; else install "$id"; fi
  done
fi
while IFS= read -r id; do
  [ -z "$id" ] && continue
  keep=0; for w in "${"$"}{WANTED[@]}"; do [ "$w" = "$id" ] && keep=1; done
  ((keep)) || { claude plugin uninstall "$id" > /dev/null 2>&1; echo "plugin $id: removed"; }
done <<<"$installed"
`;
  await runScript(r, pluginScript, log);
  log(`loadout applied in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---- Applying per workspace -----------------------------------------------------
// Workspaces apply their loadout in the background right after setup or start; a thread
// starting meanwhile joins that run instead of starting another.

type Apply = { p: Promise<void>; logs: Set<(line: string) => void> };
const gApply = globalThis as unknown as { __csLoadoutApply?: Map<string, Apply> };
const applying = (): Map<string, Apply> => (gApply.__csLoadoutApply ??= new Map());

export function loadoutApplying(workspaceId: string): boolean {
  return applying().has(workspaceId);
}

/** Runs ensureLoadout without waiting; failures are logged, and the next thread start retries. */
export function applyLoadoutInBackground(workspaceId: string, r: Remote) {
  void ensureLoadout(workspaceId, r).catch((err) => console.error(`[loadout ${workspaceId}] failed:`, err instanceof Error ? err.message : err));
}

/** Applies the workspace's loadout unless its current hash is already applied. */
export async function ensureLoadout(workspaceId: string, r: Remote, log?: (line: string) => void): Promise<void> {
  for (;;) {
    const cur = applying().get(workspaceId);
    if (cur) {
      if (log) cur.logs.add(log);
      try {
        await cur.p;
      } catch {
        // retried below if the hash still isn't applied
      } finally {
        if (log) cur.logs.delete(log);
      }
      if (!log) return;
      // A thread start that joined a failed run (or a run of an older loadout) tries again itself.
      const row = workspaceLoadout(workspaceId);
      if (!row || loadoutHash(row.loadout) === row.applied) return;
      if (applying().has(workspaceId)) continue;
    }
    const row = workspaceLoadout(workspaceId);
    if (!row) return;
    const hash = loadoutHash(row.loadout);
    if (hash === row.applied) return;
    const logs = new Set(log ? [log] : []);
    const p = applyLoadout(r, row.loadout, (line) => {
      console.log(`[loadout ${workspaceId}] ${line}`);
      for (const l of logs) l(line);
    }).then(() => {
      db().prepare("UPDATE workspaces SET loadout_applied_hash = ? WHERE id = ?").run(hash, workspaceId);
    });
    applying().set(workspaceId, { p, logs });
    try {
      await p;
    } finally {
      applying().delete(workspaceId);
    }
    return;
  }
}

function workspaceLoadout(id: string): { loadout: string[]; applied: string | null } | null {
  const row = db().prepare("SELECT loadout, loadout_applied_hash FROM workspaces WHERE id = ?").get(id) as
    | { loadout: string; loadout_applied_hash: string | null }
    | undefined;
  return row ? { loadout: JSON.parse(row.loadout) as string[], applied: row.loadout_applied_hash } : null;
}
