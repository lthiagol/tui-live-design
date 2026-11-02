# AGENTS.md

**tui-live-design** — a live TUI design canvas: a browser page renders mock
terminal UIs from a JSON spec, and coding agents edit that spec over MCP.
Agents design, users click elements and send feedback, designs persist, and
finished designs export as a deliverable bundle (`design.json` + previews).

## Which agent are you?

Read the ONE file that matches your task, before doing anything:

- **You're here to USE the canvas** — design a TUI via the MCP tools
  (e.g. an agent session working on a design):
  → read **`AGENTS-USING.md`**
- **You're here to WORK ON this codebase** — modify, review, test, or build
  the tui-live-design server/client itself:
  → read **`AGENTS-DEVELOPING.md`**
- Unsure? Ask the user which they intend.

## Non-negotiables (both audiences — the short version)

1. **Using the canvas**: the edit loop is
   `get_design → edit → update_design (base_rev REQUIRED) → wait_for_feedback → send_message`.
   Never rename/reuse element ids; the user's clicks map to them.
2. **Developing the codebase**: every agent mutation goes through
   `Session.applyAgentUpdate` (validate + revision + broadcast — never around
   it); the auth token gates every route and the WS upgrade; run
   `make check` before committing.
3. **Both**: the deferred-work list in `AGENTS-DEVELOPING.md` is deliberate —
   don't "fix" those items opportunistically.

## Repo map

`src/server/` (HTTP+WS+MCP server, sessions, validation, storage, exporters) ·
`src/client/main.ts` (browser canvas + inbox thread) ·
`src/shared/` (spec types, patch ops, renderers, themes — used by both sides) ·
`tests/` (vitest invariant suite — `make test`) ·
`.review/` (three completed review rounds; read before touching
security/concurrency code) · `designs/`+`sessions/`+`exports/` (persisted
state — gitignored).
