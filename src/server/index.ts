import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SessionRegistry } from "./registry.js";
import { createMcpServer } from "./mcp.js";
import { loadDesign, saveDesign, listDesigns } from "./storage.js";
import { isAuthorized, loadOrCreateToken, unauthorized, withSecurityHeaders } from "./auth.js";
import { isValidDesignName, DESIGN_PATH_RE } from "../shared/names.js";
import type { ServerMessage } from "../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../../public");

const PORT = Number(process.env.PORT ?? 7422);
/** Bind address. 0.0.0.0 is safe-ish ONLY because every request requires the token (C1). */
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = loadOrCreateToken();

// M9-lite: browser designs are addressed by path (grammar lives in shared/names.ts)

/** browser sockets grouped by design name */
const socketsByDesign = new Map<string, Set<WebSocket>>();

const registry = new SessionRegistry(path.join(__dirname, "../../sessions"));

// R3-C1: one-time legacy migration — guarded so it can NEVER clobber a
// design that has already been migrated; the legacy file is renamed away.
(async () => {
  try {
    const legacyPath = path.join(__dirname, "../../designs/autosave.json");
    const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
    if (await registry.hasPersisted("default")) {
      console.log("[boot] legacy autosave present but sessions/default.json exists — migration already done, skipping");
      return;
    }
    const session = await registry.getOrCreate("default");
    session.restore(legacy);
    await registry.save(session);
    await rename(legacyPath, `${legacyPath}.migrated`).catch(() => {});
    console.log(`[boot] migrated legacy autosave → sessions/default.json (rev ${session.rev})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[boot] legacy migration failed:", err instanceof Error ? err.message : err);
    }
    // ENOENT = nothing to migrate
  }
})();

/** R3-H2: per-request context — a blocking tool call pins ITS OWN request's
 * socket even when other MCP requests interleave on the same connection. */
const requestContext = new AsyncLocalStorage<{ pendingEntry: { socket: import("node:net").Socket; done: boolean } }>();

function broadcast(design: string, msg: ServerMessage) {
  const data = JSON.stringify(msg);
  const set = socketsByDesign.get(design);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > 1 << 20) {
      // R2-M4 + R3-L5: mark slow consumers stale instead of dropping silently —
      // a sweep re-syncs them from the live spec once their buffer drains
      (ws as WebSocket & { __stale?: boolean }).__stale = true;
      continue;
    }
    ws.send(data);
  }
}

// R3-L5: resync sweep — stale sockets get a fresh spec when they drain
setInterval(() => {
  for (const [design, set] of socketsByDesign) {
    const session = registry.peek(design);
    if (!session) continue;
    for (const ws of set) {
      const marked = ws as WebSocket & { __stale?: boolean };
      if (marked.__stale && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < (1 << 18)) {
        marked.__stale = false;
        ws.send(JSON.stringify({ type: "spec", spec: session.spec, rev: session.rev }));
      }
    }
  }
}, 5_000).unref();

// registry side effects: scoped broadcast + per-session autosave on every rev
registry.onSessionMessage = (session, msg) => {
  broadcast(session.id, msg);
  if (msg.type === "spec") {
    registry.save(session).catch((err) =>
      console.error(`[autosave:${session.id}]`, err instanceof Error ? err.message : err),
    );
  }
};

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
      try {
        entry.transport.close(); // R2-M1: don't leak live transports
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
    if (sessionId) console.log(`[mcp] unknown/expired session id ${sessionId} — creating fresh session`);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        mcpSessions.set(id, { server, transport, lastSeen: Date.now(), pending: [] });
        console.log(`[mcp] agent connected: ${id}`);
      },
    });
    // per-connection default design (hybrid selection): X-Design header,
    // overridable per tool call via the design argument
    const headerDesign = (req.headers["x-design"] as string | undefined) || "default";
    const server = createMcpServer({
      resolveSession: (design) => registry.getOrCreate(design ?? headerDesign),
      listSessions: () => registry.list(),
      ownLiveness: () => {
        // R3-H2: via AsyncLocalStorage this is ALWAYS this request's entry,
        // regardless of concurrent requests on the same connection
        const store = requestContext.getStore();
        if (!store) return undefined;
        const mine = store.pendingEntry;
        return () => !mine.done && !mine.socket.destroyed;
      },
    });
    const entryRef: McpEntry = { server, transport, lastSeen: Date.now(), pending: [] };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) mcpSessions.delete(id);
      console.log(`[mcp] agent disconnected: ${id}`);
    };
    entry = entryRef;
    await server.connect(transport);
  }

  if (!entry) {
    endError(res, 404, "unknown MCP session");
    return;
  }
  entry.lastSeen = Date.now();

  // R2-H1: track this request's socket so blocking tool calls can pin liveness
  const pendingEntry = { socket: req.socket, done: false };
  entry.pending.push(pendingEntry);

  try {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await requestContext.run({ pendingEntry }, () => entry.transport.handleRequest(req, res, body));
  } catch (err) {
    console.error("[mcp] request error:", err instanceof Error ? err.message : err);
    endError(res, 400, "bad request");
  } finally {
    pendingEntry.done = true;
    const idx = entry.pending.indexOf(pendingEntry);
    if (idx >= 0) entry.pending.splice(idx, 1);
  }
}

// ------------------------------------------------------------------- routes

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    // Static assets are PUBLIC: subresource requests can't carry the URL
    // token, and the shell is inert without the tokened API. /design/<name>
    // serves the same shell — the client reads the design from the path.
    const designMatch = url.pathname.match(DESIGN_PATH_RE);
    const staticPath =
      url.pathname === "/" || url.pathname === "/index.html"
        ? "index.html"
        : url.pathname === "/app.js"
          ? "app.js"
          : url.pathname === "/style.css"
            ? "style.css"
            : designMatch
              ? "index.html"
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
        "cache-control": "no-store",
      }));
      res.end(contents);
      return;
    }

    // per-design API routes: ?design=<name> (default: "default")
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    // R3-L1: materialize sessions only in routes that actually use one
    if (url.pathname === "/api/sessions") {
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify(await registry.list()));
      return;
    }

    if (url.pathname === "/api/design/list") {
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify(await listDesigns()));
      return;
    }

    const designName = url.searchParams.get("design") ?? "default";
    if (!isValidDesignName(designName)) {
      endError(res, 400, `invalid design name "${designName}"`);
      return;
    }
    const session = await registry.getOrCreate(designName);

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
    if (url.pathname === "/api/spec") {
      const body = JSON.stringify({ design: designName, rev: session.rev, spec: session.spec });
      res.writeHead(200, withSecurityHeaders({ "content-type": "application/json" }));
      res.end(body);
      return;
    }

    res.writeHead(404, withSecurityHeaders({ "content-type": "text/plain" }));
    res.end("not found");
  } catch (err) {
    // C3: nothing may escape the handler — a bad body must not kill the server
    console.error("[http]", err instanceof Error ? err.message : err);
    endError(res, 400, "bad request");
  }
});

// C1 + M9-lite: gate the WS upgrade; the design comes from ?s=<name>
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!isAuthorized(req, url, TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const design = url.searchParams.get("s") ?? "default";
  if (!isValidDesignName(design)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, design));
});

const USER_MSG_WINDOW_MS = 10_000;
const USER_MSG_MAX_PER_WINDOW = 10;

wss.on("connection", (ws: WebSocket, design: string) => {
  const set = socketsByDesign.get(design) ?? new Set<WebSocket>();
  set.add(ws);
  socketsByDesign.set(design, set);
  registry.getOrCreate(design).then((session) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "spec", spec: session.spec, rev: session.rev }));
    }
  });

  const recentMessages: number[] = [];

  ws.on("message", (raw) => {
    void (async () => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; message?: unknown };
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
        const session = await registry.getOrCreate(design);
        session.handleClientMessage(msg as never);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  ws.on("close", () => socketsByDesign.get(design)?.delete(ws));
  ws.on("error", () => socketsByDesign.get(design)?.delete(ws));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`tui-live-design canvas listening on ${HOST}:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        console.log(`  → http://${a.address}:${PORT}/?token=${TOKEN}`);
        console.log(`  → http://${a.address}:${PORT}/design/<name>?token=${TOKEN}`);
      }
    }
  }
});
