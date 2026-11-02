# AGENTS-USING.md — using the canvas as a design tool

You are an agent using tui-live-design to design a TUI with a human. This
file covers setup and the working loop. The **canonical deep reference is the
MCP resource `design://guide`** (coordinate system, node kinds, style rules,
collaboration rules) — read it via your MCP client before the first edit;
this file does not duplicate it.

## Setup (per project)

The canvas runs as a service on the host (`make url` in the repo prints the
tokened URLs; the token lives in `.design-token`). Point your harness at the
MCP endpoint with **two headers**: auth, and which design you work on.

- **Cursor** — `<project>/.cursor/mcp.json`:
  ```json
  { "mcpServers": { "tui-live-design": {
      "url": "http://<lan-ip>:7422/mcp",
      "headers": { "Authorization": "Bearer <token>", "X-Design": "<project-name>" } } } }
  ```
- **opencode** — `<project>/opencode.json`:
  ```json
  { "mcp": { "tui-live-design": {
      "type": "remote", "url": "http://<lan-ip>:7422/mcp",
      "headers": { "Authorization": "Bearer <token>", "X-Design": "<project-name>" } } } }
  ```
- **pi** — `pi mcp add -l tui-live-design --url http://<lan-ip>:7422/mcp --header "Authorization=Bearer <token>" --header "X-Design=<project-name>"`

`X-Design` names an isolated design session (per-project). Omit it and you
work on the shared `default` design — fine for a quick sketch, wrong for
parallel projects. `list_sessions` shows what exists.

## The working loop

0. Ask the user which runtime the REAL TUI will target (Textual / ratatui /
   bubbletea / blessed / Ink / other) and set `spec.target` — code export and
   hand-off depend on it. Never skip.
1. `get_design` — read spec + rev; **check the returned `design` field**
   matches what you were asked to work on (pass `design: "<name>"` on every
   tool call otherwise). The rev is your `base_rev`.
2. Edit: patch `ops` (move/resize/set_text/set_style/focus/annotate/delete/add)
   for incremental changes, full `spec` for redesigns.
3. `update_design` with `base_rev` — rejected if the design moved: re-read
   and re-apply. The user's browser re-renders instantly.
4. `wait_for_feedback` — block for the user's next composed message (their
   text + selected elements + dragged regions). On timeout, call again —
   keep waiting, don't idle.
5. `send_message` — explain changes (kind `summary`), ask questions (kind
   `question`). Loop to 1.

## Verify and hand off

- `get_screenshot` after edits — check alignment/spacing visually; don't
  trust coordinates alone.
- `export_bundle` (or `make bundle NAME=x` on the canvas host) writes
  `exports/<name>/`: `design.json` (the specification — the artifact the real
  TUI is implemented from), `preview.txt`, `preview.png`, `notes.md`
  (annotations + revisions + thread digest). That bundle is the deliverable.

## Hard limits (rejected server-side, with actionable errors)

Out-of-bounds rects, duplicate ids, invalid colors (`#rgb`/`#rrggbb` hex or
basic color names only), oversized payloads (content 2KB, title 200B, grid
200×20, ≤100 children/node, ≤2000 nodes), messages ≤ 8KB text / 100
selections / 20 regions, queue of 50 pending messages. Fix and retry — never
work around.
