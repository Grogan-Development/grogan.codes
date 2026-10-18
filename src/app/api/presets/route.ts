import { deletePreset, listPresets, savePreset } from "@/server/catalog";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json(listPresets().map((p) => ({ ...p, items: JSON.parse(p.items) as string[] }))));

export const POST = handle(async (req: Request) => {
  const { name, items } = (await req.json()) as { name: string; items: string[] };
  savePreset(name, items);
  return json({ ok: true });
});

export const DELETE = handle(async (req: Request) => {
  deletePreset(new URL(req.url).searchParams.get("id")!);
  return json({ ok: true });
});
