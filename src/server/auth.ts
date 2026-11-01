import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "../../.design-token");

/**
 * C1 mitigation: shared-secret token. The canvas must not be controllable
 * by anonymous LAN hosts — every message a "user" sends is injected into a
 * coding agent's context, so an open endpoint is a prompt-injection channel.
 *
 * Token source, in order: $TUI_LIVE_TOKEN → .design-token file → generated
 * once and persisted (so MCP client configs survive restarts).
 */
export function loadOrCreateToken(): string {
  if (process.env.TUI_LIVE_TOKEN) return process.env.TUI_LIVE_TOKEN;
  try {
    if (existsSync(TOKEN_FILE)) {
      const tok = readFileSync(TOKEN_FILE, "utf8").trim();
      if (tok.length >= 16) return tok;
    }
  } catch {
    // fall through to generation
  }
  const tok = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, tok + "\n", { mode: 0o600 });
  return tok;
}

/** R2-L6: constant-time comparison via SHA-256 digests (equal-length inputs). */
function tokenEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Check Authorization: Bearer, X-Tui-Token header, or ?token= query param. */
export function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && tokenEquals(header.slice(7), token)) return true;
  const headerToken = req.headers["x-tui-token"];
  if (typeof headerToken === "string" && tokenEquals(headerToken, token)) return true;
  const query = url.searchParams.get("token");
  return query !== null && tokenEquals(query, token);
}

export function unauthorized(res: import("node:http").ServerResponse): void {
  res.writeHead(401, withSecurityHeaders({ "content-type": "application/json" }));
  res.end(JSON.stringify({ error: "unauthorized: pass ?token= or Authorization: Bearer" }));
}

/**
 * Security headers applied to EVERY response (R2-L2), not just static files.
 * frame-src includes `about:` — srcdoc iframes have that URL, and a strict
 * frame-src without it can render them blank outside Chromium (R2-M3).
 * `unsafe-inline` in style-src is deliberate: sandboxed srcdoc custom HTML
 * styles itself via <style> tags; style injection cannot execute script.
 */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; frame-src 'self' about:; connect-src 'self'";

export function withSecurityHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", // R2-M2: never leak ?token= via Referer
    ...extra,
  };
}
