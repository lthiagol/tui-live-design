import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderSpecToSvg } from "../shared/svg.js";
import { renderSpecToText } from "../shared/text.js";
import { themeByName } from "../shared/themes.js";
import { Resvg } from "@resvg/resvg-js";
import { AGENT_GUIDE, GUIDE_URI } from "./agent-guide.js";
import { listDesigns, loadDesign, saveDesign } from "./storage.js";
import { writeBundle } from "./export/bundle.js";
import { exportRatatui } from "./export/ratatui.js";
import type { PatchOp } from "../shared/patch.js";
import type { Session } from "./session.js";

/**
 * MCP adapter — makes the design canvas usable by ANY agent harness.
 * Transport is streamable-HTTP on the same server (/mcp).
 *
 * Design selection (M9-lite, hybrid): the connection's X-Design header sets
 * the default design; every tool accepts an optional `design` argument that
 * overrides it. Agents working a single design never pass the argument.
 */
export function createMcpServer(deps: {
  resolveSession: (design?: string) => Promise<Session>;
  /** adopts THIS request's socket as a liveness check (R2-H1) */
  ownLiveness: () => (() => boolean) | undefined;
  /** discovery (M9-lite): all design sessions */
  listSessions: () => Promise<Array<{ name: string; rev: number; savedAt: string }>>;
}): McpServer {
  const server = new McpServer({
    name: "tui-live-design",
    version: "0.2.0",
  });

  const DESIGN = {
    design: z
      .string()
      .optional()
      .describe('Design (session) name; defaults to the X-Design header or "default"'),
  };

  // ---- the design guide: resource + prompt, so any harness gets the workflow
  server.registerResource(
    "design-guide",
    GUIDE_URI,
    {
      title: "Design guide",
      description:
        "How to design TUIs on this canvas: the edit loop, coordinate system, " +
        "node kinds, and collaboration rules. Read this before your first edit.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: GUIDE_URI, text: AGENT_GUIDE, mimeType: "text/markdown" }],
    }),
  );

  server.registerPrompt(
    "design-workflow",
    {
      title: "TUI design workflow",
      description:
        "Prime an agent to work on the design canvas: read the guide, then enter the edit/feedback loop.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "You are co-designing a TUI with me on a live canvas (tui-live-design). " +
              "First read the design guide resource (" +
              GUIDE_URI +
              "), then get_design and follow the loop: ask my target runtime → edit → " +
              "update_design (with base_rev) → wait_for_feedback → send_message. " +
              "Ask me before making big structural decisions.",
          },
        },
      ],
    }),
  );

  // ---- tools

  server.registerTool(
    "list_sessions",
    {
      title: "List design sessions",
      description:
        "Names, revisions and save times of all design sessions on this canvas. " +
        "Pass a name as the `design` argument on any tool to work on that design.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await deps.listSessions(), null, 2) }],
    }),
  );

  server.registerTool(
    "get_design",
    {
      title: "Get current TUI design",
      description:
        "Returns the current TUI spec (JSON) and its revision number. " +
        "Call this first to see what is currently rendered on the user's canvas. " +
        "Remember the returned rev — update_design REQUIRES it as base_rev. " +
        "Read the design-guide resource before your first edit.",
      inputSchema: { ...DESIGN },
    },
    async ({ design }) => {
      const session = await deps.resolveSession(design);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { design: session.id, rev: session.rev, spec: session.spec },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "update_design",
    {
      title: "Update the TUI design",
      description:
        "Apply changes to the design; the user's browser re-renders immediately. " +
        "Two modes — pass exactly one of:\n" +
        "- `ops`: small targeted edits (move/resize/set_text/set_style/focus/annotate/delete/add), " +
        "applied to the current spec in order. Preferred for incremental changes.\n" +
        "- `spec`: a complete TuiSpec replacement (for redesigns). " +
        "Always get_design first. Keep node ids stable when editing existing elements. " +
        "The result is validated: out-of-bounds or misplaced nodes are REJECTED with " +
        "actionable errors — fix and retry.",
      inputSchema: {
        spec: z.unknown().optional().describe("Complete TuiSpec JSON (version 1) — full replacement"),
        ops: z.array(z.unknown()).optional().describe("Patch operations applied in order"),
        note: z
          .string()
          .max(200)
          .optional()
          .describe("Short description of the change (shown in the thread, max 200 chars)"),
        base_rev: z
          .number()
          .describe(
            "REQUIRED: the rev you based your edit on (from get_design of THIS design). " +
            "If the canvas has moved since, the update is REJECTED — prevents clobbering.",
          ),
        ...DESIGN,
      },
    },
    async ({ spec, ops, note, base_rev, design }) => {
      if (ops !== undefined && spec !== undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: pass either `ops` or `spec`, not both" }],
          isError: true,
        };
      }
      if (ops === undefined && spec === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: provide `ops` or `spec`" }],
          isError: true,
        };
      }
      const session = await deps.resolveSession(design);
      const mode =
        ops !== undefined
          ? `patch with ${ops.length} op${ops.length === 1 ? "" : "s"}`
          : "full spec replacement";
      const reply = session.applyAgentUpdate({
        spec,
        ops: ops as PatchOp[] | undefined,
        note: note ?? mode,
        baseRev: base_rev,
      });
      if (!reply.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${reply.error}` }],
          isError: true,
        };
      }
      const warning =
        reply.warnings && reply.warnings.length > 0
          ? "\nWarnings:\n" + reply.warnings.map((w) => `- ${w}`).join("\n")
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Applied (${mode}) — design "${session.id}" is now at rev ${reply.rev}. ` +
              `The user sees it live; next, call wait_for_feedback for their response.${warning}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_screenshot",
    {
      title: "Screenshot the canvas",
      description:
        "Returns a PNG screenshot of the current design as an image, exactly as " +
        "the user sees it. Use it to visually verify your own layout (alignment, " +
        "spacing, overlap) after update_design — don't trust coordinates alone.",
      inputSchema: {
        scale: z
          .number()
          .optional()
          .describe("Pixel scale of the render (default 2, clamped 0.5..4)"),
        ...DESIGN,
      },
    },
    async ({ scale, design }) => {
      const session = await deps.resolveSession(design);
      const clamped = Math.min(Math.max(scale ?? 2, 0.5), 4); // M4: cap raster size
      const svg = renderSpecToSvg(session.spec, {
        scale: clamped,
        theme: themeByName(session.spec.theme).colors,
      });
      const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
      return {
        content: [
          {
            type: "image" as const,
            data: Buffer.from(png).toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.registerTool(
    "wait_for_feedback",
    {
      title: "Wait for user feedback",
      description:
        "Blocks until the user SENDS a composed message from the inbox — one message " +
        "carries their text, every element they selected (elementId, kind, title, " +
        "text, cell rect, annotation) in selection order, and any regions they " +
        "dragged on empty canvas space (cell rects with no element yet — often a " +
        "request to build something there). Clicks alone do not wake this: the user " +
        "batches deliberately. If timedOut is true, call again to keep waiting. " +
        "Use this after every update_design, and answer questions via send_message.",
      inputSchema: {
        timeout_ms: z
          .number()
          .optional()
          .describe("Max wait in ms (default 25000, max 120000)"),
        ...DESIGN,
      },
    },
    async ({ timeout_ms, design }, extra) => {
      const session = await deps.resolveSession(design);
      const liveness = deps.ownLiveness();
      const result = await session.waitForFeedback(
        Math.min(timeout_ms ?? 25_000, 120_000),
        extra?.signal, // R2-H1: cancelled notifications / transport close
        liveness, // R2-H1: raw connection death
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ design: session.id, ...result }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the user",
      description:
        "Post text to the user's inbox thread on the design canvas — explanations, " +
        "answers to their questions, or summaries of what you changed. Use kind " +
        "'question' when you need the user to decide something; they will see it " +
        "prominently and can reply from the inbox.",
      inputSchema: {
        text: z.string().describe("Message text (plain text, max 16k chars)"),
        kind: z
          .enum(["note", "question", "summary"])
          .optional()
          .describe("note = info/explanation, question = needs a reply, summary = recap of changes"),
        ...DESIGN,
      },
    },
    async ({ text, kind, design }) => {
      try {
        const session = await deps.resolveSession(design);
        const message = session.addAgentMessage(text, kind ?? "note");
        return {
          content: [
            {
              type: "text" as const,
              text: `Delivered to design "${session.id}"'s inbox (${message.kind}, ${message.at}).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "annotate",
    {
      title: "Annotate an element",
      description:
        "Attach a persistent note to an element (shown as a pin on the user's canvas " +
        "and included when the user selects that element). Use for documentation: " +
        "what an element is for, why it looks the way it does. Pass text=null to remove.",
      inputSchema: {
        id: z.string().describe("Element id"),
        text: z.string().nullable().describe("The note, or null to remove"),
        ...DESIGN,
      },
    },
    async ({ id, text, design }) => {
      const session = await deps.resolveSession(design);
      const reply = session.applyAgentUpdate({
        ops: [{ op: "annotate", id, text }],
        note: `annotate ${id}`,
      });
      if (!reply.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${reply.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Annotation ${text === null ? "removed from" : "set on"} "${id}" (rev ${reply.rev}).` }],
      };
    },
  );

  server.registerTool(
    "save_design",
    {
      title: "Save the design to disk",
      description: "Persists the current spec under a name (default: the design's id).",
      inputSchema: {
        name: z.string().optional().describe("Snapshot name (letters, digits, - and _)"),
        ...DESIGN,
      },
    },
    async ({ name, design }) => {
      try {
        const session = await deps.resolveSession(design);
        const file = await saveDesign(session.spec, session.rev, name ?? session.id);
        return { content: [{ type: "text" as const, text: `Saved to ${file} (rev ${session.rev}).` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "load_design",
    {
      title: "Load a saved design",
      description:
        "Replaces the current spec with a previously saved design. The browser re-renders immediately. " +
        "Intentionally NOT base_rev-guarded (R2-L8): load is an explicit 'replace everything' — " +
        "never call it while another agent is mid-edit.",
      inputSchema: {
        name: z.string().optional().describe("Snapshot name (default: the design's id)"),
        ...DESIGN,
      },
    },
    async ({ name, design }) => {
      try {
        const session = await deps.resolveSession(design);
        const saved = await loadDesign(name ?? session.id);
        const reply = session.applyAgentUpdate({
          spec: saved.spec,
          note: `loaded design "${name ?? session.id}"`,
        });
        if (!reply.ok) {
          return {
            content: [{ type: "text" as const, text: `Error: saved design failed validation: ${reply.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Loaded (now at rev ${reply.rev}).` }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "list_designs",
    {
      title: "List saved design snapshots",
      description: "Names and timestamps of design snapshots saved on disk (save_design).",
      inputSchema: {},
    },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await listDesigns(), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "export_bundle",
    {
      title: "Export the deliverable bundle",
      description:
        "Writes the hand-off bundle to exports/<name>/: design.json (THE specification — " +
        "cell coords, ids, styles, annotations), preview.txt (character-grid render), " +
        "preview.png, and notes.md (annotations + revisions + thread digest). This is the " +
        "deliverable for implementing the real TUI.",
      inputSchema: {
        name: z.string().optional().describe("Bundle name (default: the design's id)"),
        ...DESIGN,
      },
    },
    async ({ name, design }) => {
      try {
        const session = await deps.resolveSession(design);
        const { dir, files } = await writeBundle(session, name ?? session.id);
        const preview = renderSpecToText(session.spec);
        return {
          content: [
            {
              type: "text" as const,
              text: `Bundle written to ${dir}\nFiles: ${files.join(", ")}\n\n--- preview.txt ---\n${preview}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "export_design",
    {
      title: "Export the design as code",
      description:
        "Compiles the current spec into real TUI code. Cell coords map 1:1 to the target's " +
        "layout primitives; layout is faithful, behavior (callbacks, state) is stubbed for " +
        "you to wire up. Pass target explicitly, or rely on spec.target (set at project start).",
      inputSchema: {
        target: z
          .enum(["ratatui"])
          .optional()
          .describe("Export target; defaults to spec.target when set"),
        ...DESIGN,
      },
    },
    async ({ target, design }) => {
      const session = await deps.resolveSession(design);
      const chosen = target ?? session.spec.target;
      if (chosen !== "ratatui") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: no exporter for target "${chosen ?? "(none)"}". ` +
                `Available exporters: ratatui. Set spec.target at project start so the right ` +
                `exporter can be built, and ask the user which runtime the real TUI will use.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: exportRatatui(session.spec) }],
      };
    },
  );

  server.registerTool(
    "get_revisions",
    {
      title: "Get revision history",
      description: "Lists design revisions (rev, timestamp, note) for this design.",
      inputSchema: { ...DESIGN },
    },
    async ({ design }) => {
      const session = await deps.resolveSession(design);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              session.revisions.map((r) => ({ rev: r.rev, at: r.at, note: r.note })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
