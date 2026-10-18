import { NextResponse, type NextRequest } from "next/server";

// The API drives Claude in the sandboxes and holds the credentials, and it has no login.
// Only answer requests addressed to this machine by a local name (blocks DNS rebinding),
// and refuse writes coming from another site (blocks CSRF, including text/plain POSTs).
// Reaching it from another device: list its hostnames in CODESPACE_ALLOWED_HOSTS.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const ALLOWED = new Set([
  ...LOCAL_HOSTS,
  ...(process.env.CODESPACE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

function hostname(host: string) {
  return host.toLowerCase().replace(/:\d+$/, "");
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!ALLOWED.has(hostname(host))) return NextResponse.json({ error: "Host not allowed" }, { status: 403 });

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    const sameOrigin = origin ? new URL(origin).host.toLowerCase() === host.toLowerCase() : site !== "cross-site";
    if (!sameOrigin) return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
