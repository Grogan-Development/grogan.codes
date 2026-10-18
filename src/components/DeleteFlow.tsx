"use client";

import { useState } from "react";
import { api, ApiError, type RepoRisk } from "@/lib/api";
import { Button, Input, Modal } from "./ui";

/** Deleting checks the sandbox for uncommitted, unpushed or stashed work first. */
export function DeleteWorkspace({ id, name, onDone, onClose }: { id: string; name: string; onDone: () => void; onClose: () => void }) {
  const [phase, setPhase] = useState<"confirm" | "checking" | "risky" | "deleting">("confirm");
  const [risks, setRisks] = useState<RepoRisk[]>([]);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");

  const attempt = async (force: boolean) => {
    setPhase(force ? "deleting" : "checking");
    setError("");
    try {
      await api(`/api/workspaces/${id}${force ? "?force=1" : ""}`, { method: "DELETE" });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === "unsaved") {
        setRisks(e.body.risks as RepoRisk[]);
        setPhase("risky");
      } else {
        setError(String(e instanceof Error ? e.message : e));
        setPhase("risky");
      }
    }
  };

  return (
    <Modal title={`Delete ${name}`} onClose={onClose}>
      {phase === "confirm" && (
        <div className="space-y-3">
          <p>This permanently deletes the sandbox and everything on its disk. Codespace checks for work that isn&apos;t pushed first.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" onClick={() => attempt(false)}>
              Check &amp; delete
            </Button>
          </div>
        </div>
      )}
      {(phase === "checking" || phase === "deleting") && <p className="text-muted">{phase === "checking" ? "Checking repos for unsaved work…" : "Deleting…"}</p>}
      {phase === "risky" && (
        <div className="space-y-3">
          {error && <p className="text-bad">{error}</p>}
          {risks.length > 0 && (
            <>
              <p className="text-warn">This work only exists in the sandbox and will be lost:</p>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {risks.map((r) => (
                  <div key={r.repo} className="rounded-md border border-line p-2">
                    <div className="font-medium">{r.repo}</div>
                    {r.dirty.length > 0 && <div className="text-xs text-muted">{r.dirty.length} uncommitted change(s)</div>}
                    {r.unpushed.length > 0 && (
                      <div className="text-xs text-muted">
                        {r.unpushed.length} unpushed commit(s):
                        <pre className="font-mono mt-1 whitespace-pre-wrap">{r.unpushed.slice(0, 8).join("\n")}</pre>
                      </div>
                    )}
                    {r.stashes > 0 && <div className="text-xs text-muted">{r.stashes} stash(es)</div>}
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="text-xs text-muted">
            Type <span className="font-mono text-text">{name}</span> to delete anyway.
          </p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="w-full" />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Keep it</Button>
            <Button variant="danger" disabled={typed !== name} onClick={() => attempt(true)}>
              Delete anyway
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
