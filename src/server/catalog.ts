import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "modal";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { db } from "./db";
import { HOME, mustRun, q, run } from "./modal";

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

// ---- Applying a loadout -------------------------------------------------------

function selected(loadout: string[]): CatalogItem[] {
  const all = new Map(listCatalog().map((i) => [i.id, i]));
  return loadout.map((id) => all.get(id)).filter((i): i is CatalogItem => !!i && i.remote_ok === 1);
}

export function loadoutHash(loadout: string[]) {
  const items = selected(loadout);
  return createHash("sha256")
    .update(JSON.stringify(items.map((i) => [i.id, i.data])))
    .digest("hex")
    .slice(0, 16);
}

/** MCP servers are handed to the SDK per thread rather than written into the sandbox. */
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

/**
 * Make the sandbox's ~/.claude match the loadout: files we placed before but that are
 * no longer selected are removed; files the user created inside the sandbox are untouched.
 */
export async function applyLoadout(sb: Sandbox, loadout: string[], log: (line: string) => void = () => {}) {
  const items = selected(loadout);
  const previous: string[] = JSON.parse((await run(sb, `cat ${MANIFEST} 2>/dev/null || echo '[]'`)).output || "[]");
  const placed: string[] = [];

  for (const item of items) {
    if (item.kind === "plugin" || item.kind === "mcp") continue;
    const { files } = JSON.parse(item.data) as FileData;
    const dest = DEST[item.kind](item.name);
    for (const f of files) {
      const target = `${dest}/${f.rel}`;
      await mustRun(sb, `mkdir -p ${q(path.posix.dirname(target))}`);
      await sb.filesystem.writeBytes(Buffer.from(f.content, "base64"), target);
      placed.push(target);
    }
    log(`placed ${item.kind} ${item.name}`);
  }

  const stale = previous.filter((p) => !placed.includes(p));
  if (stale.length) await run(sb, `rm -f ${stale.map(q).join(" ")}`);

  const plugins = items.filter((i) => i.kind === "plugin").map((i) => JSON.parse(i.data) as PluginData);
  const marketplaces = new Map(plugins.map((p) => [p.marketplace, p.source]));
  for (const [name, source] of marketplaces) {
    const ref = source.repo ?? source.url;
    if (!ref) continue;
    const r = await run(sb, `claude plugin marketplace list 2>/dev/null | grep -q ${q(name)} || claude plugin marketplace add ${q(ref)}`, { timeout: 300 });
    log(`marketplace ${name}: ${r.exitCode === 0 ? "ok" : r.output.slice(-300)}`);
  }
  const wanted = new Set(plugins.map((p) => `${p.plugin}@${p.marketplace}`));
  const installedOut = (await run(sb, `claude plugin list --json 2>/dev/null || echo []`)).output;
  let installed: string[] = [];
  try {
    installed = (JSON.parse(installedOut) as { id?: string; name?: string }[]).map((p) => p.id ?? p.name ?? "");
  } catch {}
  for (const id of wanted) {
    if (installed.includes(id)) continue;
    const r = await run(sb, `claude plugin install ${q(id)}`, { timeout: 300 });
    log(`plugin ${id}: ${r.exitCode === 0 ? "installed" : r.output.slice(-300)}`);
  }
  for (const id of installed) {
    if (id && !wanted.has(id)) {
      await run(sb, `claude plugin uninstall ${q(id)}`, { timeout: 120 });
      log(`plugin ${id}: removed`);
    }
  }

  await sb.filesystem.writeText(JSON.stringify(placed), MANIFEST);
}
