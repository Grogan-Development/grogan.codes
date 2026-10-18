import { getSecret, githubToken, setSecret } from "@/server/secrets";
import { hasModalCredentials, resetModal } from "@/server/modal";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async () =>
  json({
    modal: hasModalCredentials(),
    claude: !!getSecret("claude-oauth-token"),
    github: !!githubToken(),
  }),
);

export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as { modalTokenId?: string; modalTokenSecret?: string; claudeToken?: string };
  const id = body.modalTokenId?.trim();
  const secret = body.modalTokenSecret?.trim();
  if (!!id !== !!secret) return json({ error: "Enter both the Modal token ID and secret" }, 400);
  if (id && secret) {
    setSecret("modal-token-id", id);
    setSecret("modal-token-secret", secret);
    resetModal();
  }
  if (body.claudeToken?.trim()) setSecret("claude-oauth-token", body.claudeToken.trim());
  return json({ ok: true });
});
