import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.CODESPACE_DATA_DIR ?? path.join(process.cwd(), ".data");
const KEY_FILE = path.join(DATA_DIR, "ssh", "id_ed25519");

/**
 * The app's own SSH key. Instances get the public half through user-data at launch; the
 * private half never leaves this Mac. SSH itself only travels inside an SSM session, so the
 * key is a second factor behind IAM, not the only gate.
 */
function ensureKey() {
  if (existsSync(KEY_FILE)) return;
  mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "codespace", "-f", KEY_FILE], { stdio: "ignore" });
}

export function sshPrivateKey(): Buffer {
  ensureKey();
  return readFileSync(KEY_FILE);
}

export function sshPublicKey(): string {
  ensureKey();
  return readFileSync(`${KEY_FILE}.pub`, "utf8").trim();
}
