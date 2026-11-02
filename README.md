# tui-live-design

Design terminal UIs **live, with an AI agent, in your browser**.

A web canvas renders mock TUIs from a JSON **spec** (cell-coordinate grid —
the single source of truth). Coding agents (Cursor, opencode, pi — anything
that speaks MCP) edit the spec through a tool surface; you click elements on
the canvas, write feedback, and hit Send. The agent sees exactly what you
pointed at, answers in a shared thread, and pushes revisions that re-render
instantly.

```
browser canvas ◀── WebSocket ──▶ design server ◀── MCP ──▶ any agent harness
   (click/select/send)              (spec, sessions,         (get/update design,
                                     validation, history)     wait_for_feedback…)
```

## Quick start

```bash
npm install --legacy-peer-deps
make restart          # start the canvas service
make url              # print browser URLs (tokened)
make check            # typecheck + tests
```

Open the URL, then point your agent at the MCP endpoint
(`http://<lan-ip>:7422/mcp`, `Authorization: Bearer <token>` header) —
per-harness config in [`AGENTS-USING.md`](AGENTS-USING.md).

## The workflow

1. The agent asks which runtime your real TUI will target (Textual, ratatui,
   bubbletea…) and records it in the spec
2. The agent designs; you react: click/select elements, drag regions, type
   feedback, **Send**
3. The agent explains in the thread and edits the canvas live
4. `make bundle NAME=my-design` → the deliverable:
   - `design.json` — **the specification** (implement the real TUI from this)
   - `preview.txt` / `preview.png` — readable + pixel renders
   - `notes.md` — annotations, revision history, thread digest

## What's in the box

- **13 MCP tools**: get/update design (validated, revisioned, optimistic
  concurrency), wait_for_feedback (blocking, per-request liveness), screenshots,
  annotations, session list, save/load, ratatui export, deliverable bundle
- **Named design sessions** — `/design/<name>` URLs, one canvas per project,
  autosaved with thread history
- **Token auth** on everything (the canvas can inject context into coding
  agents — it is deliberately not anonymous)
- **Validation with actionable errors** — agents self-correct in one round trip
- **39-test invariant suite** (`make test`), three completed agent-run review
  rounds (`.review/`)

## Docs

- [`AGENTS.md`](AGENTS.md) — agent entry point (routes to the right doc)
- [`AGENTS-USING.md`](AGENTS-USING.md) — using the canvas as a design tool
- [`AGENTS-DEVELOPING.md`](AGENTS-DEVELOPING.md) — working on this codebase
