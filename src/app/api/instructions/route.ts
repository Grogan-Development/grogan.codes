import { getInstructions, setInstructions } from "@/server/catalog";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

/** `{ text, isDefault, defaultText }`: the global instructions every workspace's CLAUDE.md starts with. */
export const GET = handle(async () => json(getInstructions()));

/** `{ text: string | null }`; null or blank resets to the default. */
export const PUT = handle(async (req: Request) => {
  const body = (await req.json()) as { text?: unknown };
  if (body.text !== null && typeof body.text !== "string") return json({ error: "text must be a string or null" }, 400);
  setInstructions(body.text);
  return json(getInstructions());
});
