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

/** Quote one argument for `security -i`'s command line, which follows shell-like double-quote rules. */
function securityQuote(s: string) {
  if (/[\r\n]/.test(s)) throw new Error("Secret can't contain line breaks");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function setSecret(name: SecretName, value: string) {
  // The command goes in on stdin (`security -i`) so the secret never appears in argv, where
  // any local process could read it from the process list.
  execFileSync("security", ["-i"], {
    input: `add-generic-password -U -s ${securityQuote(SERVICE)} -a ${securityQuote(name)} -w ${securityQuote(value)}\n`,
    stdio: ["pipe", "ignore", "ignore"],
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
