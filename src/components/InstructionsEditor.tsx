"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Modal } from "./ui";

type Instructions = { text: string; isDefault: boolean; defaultText: string };

/** The global instructions every workspace's CLAUDE.md starts with. */
export function InstructionsEditor({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<Instructions | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (r: Instructions) => {
    setSaved(r);
    setText(r.text);
  };

  useEffect(() => {
    api<Instructions>("/api/instructions")
      .then(apply)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  const put = async (body: { text: string | null }) => {
    setBusy(true);
    setError("");
    try {
      apply(await api<Instructions>("/api/instructions", { method: "PUT", json: body }));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!saved && text !== saved.text;
  // "Edited" means different from the default, whether saved yet or not.
  const edited = !!saved && text !== saved.defaultText;

  // Escape, the backdrop and Discard all land here; don't drop unsaved edits without asking.
  const close = () => {
    if (!dirty || confirm("Discard your unsaved changes?")) onClose();
  };

  return (
    <Modal title="Global instructions" onClose={close} wide>
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-muted">
          Written to <code className="font-mono text-text-2">~/.claude/CLAUDE.md</code> in every workspace when a thread starts, above your personal CLAUDE.md from the
          loadout. Changes apply to threads started after you save.
        </p>
        {!saved && !error ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <textarea
            aria-label="Global instructions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-[55vh] min-h-64 w-full resize-y rounded-[10px] border border-line-2 bg-panel-2 p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {saved && (
            <span className={`text-xs ${edited ? "text-warn" : "text-faint"}`}>
              {edited ? "Edited" : "Default"}
              {dirty && " · unsaved changes"}
            </span>
          )}
          {error && <span className="text-xs text-bad">{error}</span>}
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={busy || !saved || (saved.isDefault && !dirty)}
            onClick={() => {
              if (confirm("Replace your instructions with the default?")) void put({ text: null });
            }}
          >
            Reset to default
          </Button>
          <Button variant="ghost" onClick={close}>
            {dirty ? "Discard" : "Close"}
          </Button>
          <Button variant="primary" disabled={busy || !dirty} onClick={() => put({ text })}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
