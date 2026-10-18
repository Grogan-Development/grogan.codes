import { execFileSync } from "node:child_process";

// Credentials live in the macOS Keychain (service "codespace"); env vars override.
const SERVICE = "codespace";

export type SecretName = "modal-token-id" | "modal-token-secret" | "claude-oauth-token";

const ENV: Record<SecretName, string> = {
  "modal-token-id": "MODAL_TOKEN_ID",
  "modal-token-secret": "MODAL_TOKEN_SECRET",
  "claude-oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
};

export function getSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[ENV[name]];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function setSecret(name: SecretName, value: string) {
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value], {
    stdio: "ignore",
  });
}

export function githubToken(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function gitIdentity(): { name: string; email: string } {
  const read = (key: string) => {
    try {
      return execFileSync("git", ["config", "--global", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return { name: read("user.name"), email: read("user.email") };
}
