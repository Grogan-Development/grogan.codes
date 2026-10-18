import { db } from "@/server/db";
import { existingRunner, type Thread } from "@/server/threads";
import { handle, json } from "@/server/http";

export const dynamic = "force-dynamic";

/** Threads blocked on the user (an approval, a question or a plan), newest first, with what they're asking. */
export const GET = handle(async () => {
  const rows = db()
    .prepare(
      `SELECT t.*, w.name AS workspace_name FROM threads t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.status = 'waiting' ORDER BY t.updated_at DESC`,
    )
    .all() as (Thread & { workspace_name: string })[];
  return json(
    rows
      .map((t) => ({ thread: t, pending: existingRunner(t.id)?.pendingRequests() ?? [] }))
      .filter((r) => r.pending.length > 0),
  );
});
