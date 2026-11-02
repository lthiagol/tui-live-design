# AGENTS-DEVELOPING.md — working on this codebase

You are an agent modifying, reviewing, testing, or building the
tui-live-design server/client itself. Read `AGENTS.md` first (project
overview + non-negotiables); this file is the technical depth.

## Stack & layout

TypeScript everywhere. Node server (no framework): `node:http` + `ws` +
`@modelcontextprotocol/sdk` on one port (7422). Browser client: vanilla TS
bundled by esbuild, no framework. Shared modules used by both sides.

```
src/server/   index.ts (routes, auth gating, WS, MCP endpoint)
              registry.ts (named sessions: lazy materialize, autosave)
              session.ts (state, message queue, wait_for_feedback)
              mcp.ts (13 tools), validate.ts, storage.ts (snapshots)
              agent-guide.ts (served as design://guide), export/ (bundle, ratatui)
src/client/   main.ts (renderer, selection/drag, composer, thread, switcher)
src/shared/   spec.ts (types), sample.ts, patch.ts, text.ts, svg.ts, themes.ts, names.ts
tests/        vitest invariant suite
```

## Invariants (breaking any of these is a bug regardless of tests)

1. **Single mutation funnel**: ALL agent-driven spec changes go through
   `Session.applyAgentUpdate` — baseRev check → patch-or-spec → `validateSpec`
   → revision + emit. Never mutate `session.spec` directly; never add a
   mutation path that skips validation (annotate and load both funnel through
   it — keep it that way).
2. **Waiter queue semantics** (`session.ts`): one user-message batch is
   delivered atomically to exactly one FIFO waiter; timing-out/cancelled/
   dead waiters leave WITHOUT draining (nothing is ever lost). Liveness
   pinning is per-HTTP-request via `AsyncLocalStorage` in `index.ts` — the
   SDK never aborts tool handlers on connection death, so don't "simplify"
   this away.
3. **Auth**: the token gates every route and the WS upgrade. New endpoints
   must call `isAuthorized` and return via `withSecurityHeaders`.
   Static shell (`/`, `/app.js`, `/style.css`, `/design/*`) is deliberately
   public — it's inert without the tokened API (subresources can't carry
   query tokens).
4. **ids are the contract**: element ids map browser clicks to spec nodes;
   stability rules live in the guide.
5. **Persistence**: sessions autosave atomically (tmp+fsync+rename), serialized
   per session; restored specs pass `validateSpec`; corrupt files are
   quarantined, never overwritten. The legacy-migration is guarded by
   `hasPersisted` — it must stay one-time.
6. **Names**: design names are lowercase `[a-z0-9_-]{1,40}` (APFS is
   case-insensitive — uppercase would alias designs). Grammar lives only in
   `src/shared/names.ts`.

## Workflow

- `make check` before committing (typecheck incl. `tests/` + 39 tests).
  `make help` lists everything (dev/restart/logs/url/bundle/mcp-save…).
- The server runs as launchd service `com.tui-live-design.canvas` — restart
  with `make restart` after server changes; logs at `/tmp/tui-live-design.*`.
- Client changes need `npm run build` (or `make dev` for watchers).
- Verification beyond unit tests is done with curl/node one-liners against
  the live server (token via `.design-token`) — see examples in this
  project's chat history style: initialize → notifications/initialized →
  tools/call against `/mcp`.

## Review history — read before security/concurrency work

`.review/findings.md`, `findings-2.md`, `findings-3.md` — three completed
rounds (agent-designed agent-reviewed): auth/token design, waiter queue
races, migration guarding, session materialization. Their "verified fixed"
sections double as a map of where the bodies are buried.

## Deliberately deferred — do NOT fix opportunistically

- **M9-full**: session ids inside wire messages, agent attribution in the
  thread, published JSON Schema for PatchOp, structured error codes.
  Requires a wire-protocol design round.
- **Multi-screen designs** (schema change: screens + navigation).
- **L6**: full-DOM rebuild per spec update → keyed reconciliation when
  specs grow.
- **Session eviction** (R3-L1 second half): evicting idle sessions risks
  re-introducing feedback loss against fresh instances — needs a design
  that interacts with the waiter queue safely.
- **Server constructible-in-tests**: index.ts binds a port at import time,
  so routing has no vitest coverage yet — fix by exporting a factory before
  adding routing tests.
