import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.CODESPACE_DATA_DIR ?? path.join(process.cwd(), ".data");

const g = globalThis as unknown as { __csDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__csDb) {
    mkdirSync(DATA_DIR, { recursive: true });
    const d = new DatabaseSync(path.join(DATA_DIR, "codespace.db"));
    d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(d);
    recoverFromRestart(d);
    g.__csDb = d;
  }
  return g.__csDb;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sandbox_id TEXT,
      state TEXT NOT NULL DEFAULT 'creating',
      error TEXT,
      snapshot TEXT NOT NULL,
      idle_minutes INTEGER NOT NULL DEFAULT 30,
      loadout TEXT NOT NULL DEFAULT '[]',
      loadout_applied_hash TEXT,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT,
      state TEXT NOT NULL DEFAULT 'cloning',
      error TEXT,
      UNIQUE (workspace_id, name)
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      repo TEXT,
      session_id TEXT,
      model TEXT,
      permission_mode TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    );
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      data TEXT NOT NULL,
      remote_ok INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      items TEXT NOT NULL
    );
  `);
  // Modal: a stopped workspace is a filesystem snapshot (image_id) that the next start boots from.
  const cols = new Set((d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("gpu")) d.exec("ALTER TABLE workspaces ADD COLUMN gpu TEXT");
  if (!cols.has("image_id")) d.exec("ALTER TABLE workspaces ADD COLUMN image_id TEXT");
  if (!cols.has("sandbox_started_at")) d.exec("ALTER TABLE workspaces ADD COLUMN sandbox_started_at INTEGER");
  // Machine dials. Null on older rows, which fall back to their size preset.
  if (!cols.has("cpu")) d.exec("ALTER TABLE workspaces ADD COLUMN cpu REAL");
  if (!cols.has("memory_mib")) d.exec("ALTER TABLE workspaces ADD COLUMN memory_mib INTEGER");
  if (!cols.has("disk_gb")) d.exec("ALTER TABLE workspaces ADD COLUMN disk_gb INTEGER");
  if (!cols.has("disk_used_mb")) d.exec("ALTER TABLE workspaces ADD COLUMN disk_used_mb INTEGER");
}

/**
 * Runs once per server process. Turns, permission prompts and provisioning all live in
 * memory, so any state saying one is in progress is left over from a previous process.
 */
function recoverFromRestart(d: DatabaseSync) {
  d.exec(`
    UPDATE threads SET status = 'idle' WHERE status IN ('starting', 'running', 'waiting');
    UPDATE workspaces SET state = 'setup failed', error = 'Setup was interrupted by a server restart'
      WHERE state IN ('creating', 'setting up');
    UPDATE workspaces SET state = 'error', error = 'Snapshot was interrupted by a server restart'
      WHERE state = 'snapshotting';
  `);
}

export function now() {
  return Date.now();
}
