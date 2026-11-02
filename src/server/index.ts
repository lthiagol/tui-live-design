import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Session } from "./session.js";
import { createMcpServer } from "./mcp.js";
import { loadDesign, listDesigns, saveDesign } from "./storage.js";
import { isAuthorized, loadOrCreateToken, unauthorized, withSecurityHeaders } from "./auth.js";
import type { ClientMessage, ServerMessage } from "../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../../public");

const PORT = Number(process.env.PORT ?? 7422);
/** Bind address. 0.0.0.0 is safe-ish ONLY because every request requires the token (C1). */
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = loadOrCreateToken();

const session = new Session("default");

// Auto-persist: every spec revision lands in designs/autosave.json and is
// restored on boot — a service restart must never silently wipe a design.
(async () => {
  try {
    const saved = await loadDesign("autosave");
    const reply = session.applyAgentUpdate({
      spec: saved.spec,
      note: `restored autosave (was rev ${saved.rev})`,
    });
    console.log(`[boot] restored autosave → rev ${reply.rev}`);
  } catch {
    console.log("[boot] no autosave found — starting from sample");
  }
})();

/** browser connections for the live canvas */
const sockets = new Set<WebSocket>();

/** R2-M4: skip consumers whose send buffer is backing up */
const SLOW_CONSUMER_BYTES = 1 << 20;

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > SLOW_CONSUMER_BYTES) continue;
    ws.send(data);
  }
  if (msg.type === "spec") {
    saveDesign(msg.spec, msg.rev, "autosave").catch((err) =>
      console.error("[autosave]", err instanceof Error ? err.message : err),
    );
  }
}
session.onEmit = broadcast;

const MAX_BODY = 1 << 20; // 1 MiB — plenty for any legit design/message (H5)

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim();
  if (type !== "application/json") {
    throw new Error("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error(`body too large (max ${MAX_BODY} bytes)`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** R2-L3: the only safe way to finish an errored response */
function endError(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, withSecurityHeaders({ "content-type": "application/json" }));
  }
  res.end(JSON.stringify({ error: message }));
}

// ------------------------------------------------------------- MCP endpoint

/** connected MCP agents, keyed by Mcp-Session-Id (M1: with lastSeen sweep) */
interface McpEntry {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** R2-H1: in-flight requests — lets wait_for_feedback pin its own socket */
  pending: Array<{ socket: import("node:net").Socket; done: boolean }>;
}
const mcpSessions = new Map<string, McpEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of mcpSessions) {
    if (now - entry.lastSeen > 30 * 60_000) {
      mcpSessions.delete(id);
      // R2-M1: close the transport too — a Map delete alone leaks the live
      // McpServer/transport (and its ~14 registered tool closures)
      try {
        entry.transport.close();
      } catch {
        // already gone
      }
      console.log(`[mcp] reaped idle agent session: ${id}`);
    }
  }
}, 60_000).unref();

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let entry = sessionId ? mcpSessions.get(sessionId) : undefined;

  if (req.method === "POST" && !entry) {
    // R2-M1: a stale/reaped session id silently forking a fresh session is
    // surprising — at least make it visible in the log
    if (sessionId) console.log(`[mcp] unknown/expired session id ${sessionId} — creating fresh session`);
    // new MCP session: fresh transport + server bound to our design session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        mcpSessions.set(id, { server, transport, lastSeen: Date.now(), pending: [] });
        console.log(`[mcp] agent connected: ${id}`);
      },
    });
    const server = createMcpServer(session);
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) mcpSessions.delete(id);
      console.log(`[mcp] agent disconnected: ${id}`);
    };
    entry = { server, transport, lastSeen: Date.now(), pending: [] };
    await server.connect(transport);
  }

  if (!entry) {
    endError(res, 404, "unknown MCP session");
    return;
  }
  entry.lastSeen = Date.now();

  // R2-H1: expose per-request liveness — a blocking tool call adopts the
  // newest pending request (its own) and stays alive only while that
  // request's socket lives. Dead client → poll fires within ~2s.
  const pendingEntry = { socket: req.socket, done: false };
  entry.pending.push(pendingEntry);
  session.setWaitLivenessProvider(() => {
    const mine = pendingEntry;
    return () => !mine.done && !mine.socket.destroyed;
  });

  try {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await entry.transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[mcp] request error:", err instanceof Error ? err.message : err);
    endError(res, 400, "bad request");
  } finally {
    // R2-H1: request finished (normally or not) — stop being anyone's liveness anchor
    pendingEntry.done = true;
    const idx = entry.pending.indexOf(pendingEntry);
    if (idx >= 0) entry.pending.splice(idx, 1);
  }
}

// ------------------------------------------------------------------- routes

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    // Static assets are PUBLIC: subresource requests (<script>/<link>) can't
    // carry the URL token, and the shell is inert without the tokened API.
    // Everything that matters — /api/*, /mcp, the WS upgrade — stays gated.
    const staticPath = url.pathname === "/" || url.pathname === "/index.html"
      ? "index.html"
      : url.pathname === "/app.js"
        ? "app.js"
        : url.pathname === "/style.css"
          ? "style.css"
          : null;

    // C1: everything except the static shell requires the token
    if (!staticPath && !isAuthorized(req, url, TOKEN)) {
      unauthorized(res);
      return;
    }

    if (staticPath) {
      const contents = await readFile(path.join(PUBLIC_DIR, staticPath));
      const type =
        staticPath === "index.html" ? "text/html"
        : staticPath === "app.js" ? "text/javascript"
        : "text/css";
      res.writeHead(200, withSecurityHeaders({
        "content-type": type,
        "cache-control": "no-store", // never serve a stale shell again
      }));
      res.end(contents);
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    if (url.pathname === "/api/design/save" && req.method === "POST") {
      const body = (await readJsonBody(req)) as { name?: string };
      const file = await saveDesign(session.spec, session.rev, body.name ?? session.id);
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: true, file }));
      return;
    }
    if (url.pathname === "/api/design/load" && req.method === "POST") {
      const body = (await readJsonBody(req)) as { name?: string };
      const saved = await loadDesign(body.name ?? session.id);
      const reply = session.applyAgentUpdate({
        spec: saved.spec,
        note: `loaded design "${body.name ?? session.id}"`,
      });
      if (!reply.ok) {
        res.writeHead(400, withSecurityHeaders({ "content-type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: reply.error }));
        return;
      }
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: true, rev: reply.rev }));
      return;
    }
    if (url.pathname === "/api/design/list") {
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify(await listDesigns()));
      return;
    }
    if (url.pathname === "/api/spec") {
      const body = JSON.stringify({ rev: session.rev, spec: session.spec });
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(body);
      return;
    }

    res.writeHead(404, withSecurityHeaders({ "content-type": "text/plain" }));
    res.end("not found");
    return;
  } catch (err) {
    // C3: nothing may escape the handler — a bad body must not kill the server
    console.error("[http]", err instanceof Error ? err.message : err);
    endError(res, 400, "bad request");
  }
});

// C1: gate the WebSocket upgrade on the token too
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!isAuthorized(req, url, TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// R2-M4: per-connection rate limit for user_message bursts
const USER_MSG_WINDOW_MS = 10_000;
const USER_MSG_MAX_PER_WINDOW = 10;

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: "spec", spec: session.spec, rev: session.rev }));
  const recentMessages: number[] = [];

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as ClientMessage;
      if (msg.type === "user_message") {
        const now = Date.now();
        while (recentMessages.length > 0 && now - recentMessages[0]! > USER_MSG_WINDOW_MS) {
          recentMessages.shift();
        }
        if (recentMessages.length >= USER_MSG_MAX_PER_WINDOW) {
          ws.send(JSON.stringify({
            type: "error",
            message: `rate limited: max ${USER_MSG_MAX_PER_WINDOW} messages per ${USER_MSG_WINDOW_MS / 1000}s`,
          }));
          return;
        }
        recentMessages.push(now);
      }
      session.handleClientMessage(msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
    }
  });

  ws.on("close", () => sockets.delete(ws));
  ws.on("error", () => sockets.delete(ws));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`tui-live-design canvas listening on ${HOST}:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        console.log(`  → http://${a.address}:${PORT}/?token=${TOKEN}`);
      }
    }
  }
});
