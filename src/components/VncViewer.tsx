"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * The workspace's VNC desktop. The noVNC client is bundled with the app; it asks the server
 * to start the desktop, then connects to the websocket URL it returns: a local port forwarded
 * over SSH to websockify on the instance.
 */
export function VncViewer({ workspaceId }: { workspaceId: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Starting desktop…");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let rfb: { disconnect(): void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const [{ wsUrl }, { default: RFB }] = await Promise.all([
          api<{ wsUrl: string }>(`/api/workspaces/${workspaceId}/desktop`, { method: "POST" }),
          import("@novnc/novnc"),
        ]);
        if (cancelled || !screen.current) return;
        setStatus("Connecting…");
        const r = new RFB(screen.current, wsUrl, { shared: true, wsProtocols: ["binary"] });
        r.scaleViewport = true;
        r.addEventListener("connect", () => setStatus(""));
        r.addEventListener("disconnect", (e) => {
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          setStatus(clean ? "Disconnected." : "Lost the connection to the desktop.");
        });
        rfb = r;
      } catch (err) {
        if (!cancelled) setStatus(String(err instanceof Error ? err.message : err));
      }
    })();
    return () => {
      cancelled = true;
      rfb?.disconnect();
    };
  }, [workspaceId, attempt]);

  return (
    <div className="relative h-full w-full bg-black">
      <div ref={screen} className="h-full w-full" />
      {status && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted">
          <span>{status}</span>
          {/^(Disconnected|Lost)/.test(status) && (
            <button className="text-accent underline" onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
