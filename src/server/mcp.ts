import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "./session.js";
import { renderSpecToSvg } from "../shared/svg.js";
import { Resvg } from "@resvg/resvg-js";
import { AGENT_GUIDE, GUIDE_URI } from "./agent-guide.js";
import { listDesigns, loadDesign, saveDesign } from "./storage.js";
import { exportRatatui } from "./export/ratatui.js";
import type { PatchOp } from "../shared/patch.js";

/**
 * MCP adapter — makes the design canvas usable by ANY agent harness.
 * Transport is streamable-HTTP on the same server (/mcp), so agents can
 * connect over the LAN just like the browser does.
 */
export function createMcpServer(session: Session): McpServer {
  const server = new McpServer({
    name: "tui-live-design",
    version: "0.1.0",
  });

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
              "), then get_design and follow the loop: edit → update_design → " +
              "wait_for_feedback → send_message. Ask me before making big structural decisions.",
          },
        },
      ],
    }),
  );

  // ---- tools

  server.registerTool(
    "get_design",
    {
      title: "Get current TUI design",
      description:
        "Returns the current TUI spec (JSON) and its revision number. " +
        "Call this first to see what is currently rendered on the user's canvas. " +
        "Remember the returned rev — update_design REQUIRES it as base_rev. " +
        "Read the design-guide resource before your first edit.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ rev: session.rev, spec: session.spec }, null, 2),
        },
      ],
    }),
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
            "REQUIRED: the rev you based your edit on (from get_design). If the canvas has " +
            "moved since, the update is REJECTED — prevents clobbering concurrent edits.",
          ),
      },
    },
    async ({ spec, ops, note, base_rev }) => {
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
              `Applied (${mode}) — canvas is now at rev ${reply.rev}. ` +
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
          .describe("Pixel scale of the render (default 2 = retina-ish)"),
      },
    },
    async ({ scale }) => {
      const clamped = Math.min(Math.max(scale ?? 2, 0.5), 4); // M4: cap raster size
      const svg = renderSpecToSvg(session.spec, { scale: clamped });
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
      },
    },
    async ({ timeout_ms }, extra) => {
      // R2-H1: pin liveness to THIS request's socket; SDK signal covers
      // well-behaved cancellation (notifications/cancelled, transport close)
      const liveness = session.getWaitLivenessProvider()?.();
      const result = await session.waitForFeedback(
        Math.min(timeout_ms ?? 25_000, 120_000),
        extra?.signal,
        liveness,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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
      },
    },
    async ({ id, text }) => {
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
    "send_message",
    {
      title: "Send a message to the user",
      description:
        "Post text to the user's inbox thread on the design canvas — explanations, " +
        "answers to their questions, or summaries of what you changed. Use kind " +
        "'question' when you need the user to decide something; they will see it " +
        "prominently and can reply from the inbox.",
      inputSchema: {
        text: z.string().describe("Message text (plain text)"),
        kind: z
          .enum(["note", "question", "summary"])
          .optional()
          .describe("note = info/explanation, question = needs a reply, summary = recap of changes"),
      },
    },
    async ({ text, kind }) => {
      try {
        const message = session.addAgentMessage(text, kind ?? "note");
        return {
          content: [
            {
              type: "text" as const,
              text: `Delivered to the user's inbox (${message.kind}, ${message.at}).`,
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
    "save_design",
    {
      title: "Save the design to disk",
      description: "Persists the current spec under a name (default: the session id).",
      inputSchema: {
        name: z.string().optional().describe("Design name (letters, digits, - and _)"),
      },
    },
    async ({ name }) => {
      try {
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
        name: z.string().optional().describe("Design name (default: the session id)"),
      },
    },
    async ({ name }) => {
      try {
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
      title: "List saved designs",
      description: "Names and timestamps of designs saved on disk.",
      inputSchema: {},
    },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await listDesigns(), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "export_design",
    {
      title: "Export the design as code",
      description:
        "Compiles the current spec into real TUI code. Target 'ratatui' (Rust) — " +
        "cell coords map 1:1 to Rect; layout is faithful, behavior (callbacks, state) " +
        "is stubbed for you to wire up.",
      inputSchema: {
        target: z.enum(["ratatui"]).describe("Export target"),
      },
    },
    async ({ target }) => {
      if (target !== "ratatui") {
        return {
          content: [{ type: "text" as const, text: `Error: unknown target "${target}"` }],
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
      description: "Lists design revisions (rev, timestamp, note).",
      inputSchema: {},
    },
    async () => ({
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
    }),
  );

  return server;
}
