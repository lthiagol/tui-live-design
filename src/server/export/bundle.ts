import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { renderSpecToText } from "../../shared/text.js";
import { renderSpecToSvg } from "../../shared/svg.js";
import { themeByName } from "../../shared/themes.js";
import type { Session } from "../session.js";
import type { TuiNode } from "../../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, "../../../exports");

/**
 * The deliverable bundle — what a human or agent implements the REAL TUI from:
 *   design.json  ← the specification (source of truth)
 *   preview.txt  ← character-grid render (readable snapshot)
 *   preview.png  ← pixel render (visual check)
 *   notes.md     ← the why: annotations, revisions, thread digest
 */

function collectAnnotations(root: TuiNode): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const walk = (n: TuiNode) => {
    if (n.annotation) out.push({ id: n.id, text: n.annotation });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

export function buildNotesMarkdown(session: Session): string {
  const spec = session.spec;
  const lines: string[] = [];
  lines.push(`# Design notes — ${session.id}`);
  lines.push("");
  lines.push(`- terminal: ${spec.term.cols}×${spec.term.rows} cells`);
  lines.push(`- theme: ${spec.theme ?? "tokyonight (default)"}`);
  lines.push(`- target runtime: **${spec.target ?? "⚠ not set — ask the user at project start"}**`);
  lines.push(`- current rev: ${session.rev}`);
  lines.push("");

  const annotations = collectAnnotations(spec.root);
  if (annotations.length > 0) {
    lines.push("## Element annotations (the why)");
    lines.push("");
    for (const a of annotations) lines.push(`- \`${a.id}\`: ${a.text}`);
    lines.push("");
  }

  lines.push("## Revision history");
  lines.push("");
  for (const r of session.revisions) lines.push(`- **rev ${r.rev}** (${r.at}): ${r.note}`);
  lines.push("");

  lines.push("## Design thread digest");
  lines.push("");
  for (const m of session.threadHistory) {
    const who = m.who === "user" ? "user" : `agent (${m.kind})`;
    lines.push(`- **${who}**: ${m.text.replaceAll("\n", " ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeBundle(
  session: Session,
  name: string,
): Promise<{ dir: string; files: string[] }> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "bundle";
  const dir = path.join(EXPORTS_DIR, safe);
  await mkdir(dir, { recursive: true });

  const files: string[] = [];
  const write = async (file: string, data: string | Buffer) => {
    await writeFile(path.join(dir, file), data);
    files.push(file);
  };

  await write("design.json", JSON.stringify(session.spec, null, 2));
  await write("preview.txt", renderSpecToText(session.spec) + "\n");
  const svg = renderSpecToSvg(session.spec, { theme: themeByName(session.spec.theme).colors });
  await write("preview.png", Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng()));
  await write("notes.md", buildNotesMarkdown(session));
  return { dir, files };
}
