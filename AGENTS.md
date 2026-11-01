# AGENTS.md — tui-live-design

A live TUI design canvas: a browser page renders a mock terminal UI from a
JSON **spec** (single source of truth), and coding agents edit that spec over
**MCP**. Users click/select elements on the canvas and send composed feedback;
agents see exactly what was pointed at (element id, kind, title, cell rect)
and can push updated designs that re-render instantly.

This document covers both: **using the canvas as an agent** (the MCP loop)
and **working on this codebase**.

---

## Running the canvas

```bash
npm install
npm run dev        # server (tsx watch) + client (esbuild watch)
```

- Production-ish: the server runs as a launchd service
  `com.tui-live-design.canvas` (plist in `~/Library/LaunchAgents/`).
  `launchctl kickstart -k gui/$(id -u)/com.tui-live-design.canvas` restarts it;
  logs in `/tmp/tui-live-design.log` and `/tmp/tui-live-design.err.log`.
- Auth: every request (HTTP, WebSocket upgrade, MCP) requires a token.
  `src/server/auth.ts` loads `$TUI_LIVE_TOKEN` → `.design-token` → generates.
  Startup prints LAN URLs already containing `?token=`.
- Browser: open `http://<lan-ip>:7422/?token=<token>` (the client stores the
  token in sessionStorage and strips it from the address bar).
- `npm run typecheck` (tsc), `npm run build` (esbuild → `public/app.js`).
  After changing server code without `npm run dev`, restart the service.

## Connecting an agent (MCP over streamable HTTP)

Endpoint: `http://<lan-ip>:7422/mcp` — auth via `Authorization: Bearer <token>`
header (or `?token=` query). Read the token from `.design-token`.

Supported harnesses (all verified):

- **Cursor** — `.cursor/mcp.json` in this repo (already configured with the
  local token):
  ```json
  { "mcpServers": { "tui-live-design": {
      "url": "http://192.168.69.60:7422/mcp",
      "headers": { "Authorization": "Bearer <token>" } } } }
  ```
- **opencode** — `opencode.json` in this repo (already configured):
  ```json
  { "mcp": { "tui-live-design": {
      "type": "remote", "url": "http://192.168.69.60:7422/mcp",
      "headers": { "Authorization": "Bearer <token>" } } } }
  ```
- **pi** — supports streamable HTTP + headers:
  `pi mcp add -l tui-live-design --url http://<lan-ip>:7422/mcp --header "Authorization=Bearer <token>"`
  (local project config in `.pi/mcp.json`, ignored until the project is
  trusted — start pi in the project once and trust it).
- Any other MCP client with streamable-HTTP + custom headers works the same
  way. Stdio-only clients are not supported (by design — the canvas is a
  network service, not a child process).

## The design loop (follow this exactly)

1. **`get_design`** — read the current spec and its `rev`. The rev is your
   `base_rev` for step 3.
2. Modify the spec — full replacement, or (preferred) a patch of ops.
3. **`update_design`** with `base_rev`. If the canvas moved since you read it
   you'll be rejected: call `get_design` again and re-apply your change.
4. **`wait_for_feedback`** — block until the user sends a composed message
   (their text + selected elements + dragged regions). If it times out, call
   it again — keep waiting rather than going idle.
5. **`send_message`** — explain what you changed / ask questions; loop back
   to 1.

Before your first edit, read the **design guide**: MCP resource
`design://guide` (workflow, coordinate system, node kinds, style rules,
collaboration rules). There is also an MCP prompt `design-workflow` that
primes a fresh agent.

## Tool reference

| Tool | Purpose |
|---|---|
| `get_design` | Current spec + rev (rev = your `base_rev`) |
| `update_design` | Apply `ops` (move/resize/set_text/set_style/focus/annotate/delete/add) or a full `spec`; requires `base_rev`; validated, revisioned, pushed live |
| `wait_for_feedback` | Block for the user's next composed message (max 120s per call) |
| `send_message` | Post to the user's inbox thread (`note`/`question`/`summary`) |
| `get_screenshot` | PNG of the current canvas as an image block — verify your layout visually |
| `annotate` | Persistent note on an element (shown as ★ pin, rides along in selections) |
| `save_design` / `load_design` / `list_designs` | Persistence under `designs/` |
| `export_design` | Compile the spec to code (target: `ratatui`) |
| `get_revisions` | Revision history notes |

## The spec, in brief

Everything is in **cell coordinates** (`term.cols × term.rows`, default 80×24).
Node kinds: `root`, `panel`, `text`, `button`, `input`, `grid`, `statusbar`.
Each node: `id` (stable, kebab-case — NEVER rename/reuse), `kind`, `rect`
(`{x,y,w,h}`, includes borders), optional `title`/`content`/`data`/`style`/
`annotation`/`children`/`customHtml` (rendered in a sandboxed iframe).
Theme: `spec.theme` = one of `tokyonight|catppuccin|nord|gruvbox|dracula`;
`spec.boxDrawing` = double-line border mode.

Validation rejects: out-of-terminal or out-of-parent rects, duplicate ids,
bad colors (hex `#rgb/#rrggbb` or basic names only), oversized payloads
(content 2KB, title 200B, grid 200×20, ≤100 children, ≤2000 nodes), missing
fields — with actionable error messages. Fix and retry; don't work around.

Limits to respect: messages ≤ 8KB text / 100 selections / 20 regions;
`send_message` ≤ 16KB; `note` ≤ 200 chars; feedback queue holds 50 messages;
10 user messages per 10s per connection; body ≤ 1MiB.

## Working on this codebase

- **Stack**: TypeScript everywhere. Server: node:http + `ws` + MCP SDK
  (`@modelcontextprotocol/sdk`) on the same port; client: vanilla TS bundled
  by esbuild, no framework; shared spec/patch/themes/svg modules in
  `src/shared/` used by both sides.
- **Layout**: `src/server/` (`index` routes/auth/WS, `session` state+message
  queue, `mcp` tools, `validate`, `storage`, `agent-guide`, `export/`),
  `src/client/main.ts` (renderer, selection, drag, composer, thread),
  `src/shared/` (`spec` types, `sample`, `patch` ops, `svg` renderer,
  `themes`).
- **Invariants** (don't break these):
  - ALL agent mutations go through `Session.applyAgentUpdate` — never call
    `applySpec`-style writes that skip validation; never mutate `session.spec`
    directly.
  - One `user_message` batch is delivered atomically to exactly one
    `wait_for_feedback` waiter (FIFO). Waiter liveness is pinned per-request;
    `Session.setWaitLivenessProvider` is wired from `handleMcp` — keep it.
  - The token gates every route and the WS upgrade. New endpoints must check
    `isAuthorized` and use `withSecurityHeaders`.
  - Client clicks map to spec nodes by `data-id`; ids are the contract.
- **Testing**: there is no test framework yet — verification is done with
  curl/node one-liners against the live server (see git-less history in
  `.review/` for examples). If you add features, exercise them end-to-end the
  same way and typecheck.
- **Reviews**: two review rounds live in `.review/findings.md` and
  `findings-2.md` — read them before refactoring security- or
  concurrency-sensitive code.

## Known deferred work (agreed, don't "fix" opportunistically)

- **M9: multi-session/multi-design** — needs wire-protocol session ids,
  per-session routing, agent attribution. Design round required.
- Protocol observations: structured error codes (not prose strings), JSON
  Schema publication of `PatchOp`, rev semantics.
- L6: full DOM rebuild per spec update → keyed reconciliation when specs grow.
