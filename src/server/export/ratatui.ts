import type { TuiNode, TuiSpec } from "../../shared/spec.js";

/**
 * Export the spec to ratatui (Rust) code. Cell coords map 1:1 to
 * Rect::new(x, y, w, h), so this is a faithful skeleton: real widgets,
 * real positions, styling carried over. Interactive behavior (callbacks,
 * state) is stubbed — it's a starting point, not a full app.
 */

/**
 * L1: safe, unique Rust identifiers — the n_ prefix alone makes keyword and
 * digit-leading collisions impossible; dedupe handles normalization clashes
 * (a-b and a_b → n_a_b).
 */
function makeVarNamer(): (id: string) => string {
  const used = new Set<string>();
  return (id: string) => {
    let base = "n_" + id.replaceAll(/[^a-zA-Z0-9]/g, "_").replaceAll(/_{2,}/g, "_");
    if (base === "n_" || base.length < 3) base = `n_node_${base.slice(2) || "x"}`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };
}

/** L2: unknown colors get a visible NOTE in the output instead of silently diverging. */
function colorRust(c: string | undefined, fallback: string, notes: string[]): string {
  if (!c) return fallback;
  const named: Record<string, string> = {
    black: "Black", red: "Red", green: "Green", yellow: "Yellow",
    blue: "Blue", magenta: "Magenta", cyan: "Cyan", gray: "Gray",
    white: "White", grey: "Gray",
  };
  const lower = c.toLowerCase().trim();
  if (named[lower]) return `Color::${named[lower]}`;
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return `Color::Rgb((${n} >> 16) & 0xff, (${n} >> 8) & 0xff, ${n} & 0xff)`;
  }
  notes.push(`color "${c}" is not a basic name or #rrggbb hex — mapped to its fallback`);
  return fallback;
}

function rustStr(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function styleRust(node: TuiNode, notes: string[], defaultFg = "Color::Reset"): string {
  const parts: string[] = [];
  if (node.style?.fg) parts.push(`.fg(${colorRust(node.style.fg, defaultFg, notes)})`);
  if (node.style?.bg) parts.push(`.bg(${colorRust(node.style.bg, "Color::Reset", notes)})`);
  if (node.style?.bold) parts.push(".bold()");
  if (node.style?.dim) parts.push(".dim()");
  return parts.length ? `.style(Style::default()${parts.join("")})` : "";
}

function emitNode(node: TuiNode, out: string[], notes: string[], varFor: (id: string) => string): void {
  if (node.kind === "root") {
    for (const child of node.children ?? []) emitNode(child, out, notes, varFor);
    return;
  }
  const r = node.rect;
  const rect = `Rect::new(${r.x}, ${r.y}, ${r.w}, ${r.h})`;
  const varName = varFor(node.id);

  switch (node.kind) {
    case "panel":
      out.push(
        `    // ${node.id}: panel${node.title ? ` "${node.title.trim()}"` : ""}`,
        `    let ${varName} = Block::default().borders(Borders::ALL)` +
          (node.title ? `.title(${rustStr(node.title)})` : "") +
          `${styleRust(node, notes, "Color::Dim")};`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
    case "text":
      out.push(
        `    // ${node.id}: text`,
        `    let ${varName} = Paragraph::new(${rustStr(node.content ?? "")})` +
          `${styleRust(node, notes)};`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
    case "button":
      out.push(
        `    // ${node.id}: button (ratatui has no button widget — rendered as a styled block; wire the click area yourself)`,
        `    let ${varName} = Paragraph::new(Span::styled(${rustStr(node.title ?? "")}, Style::default()${node.style?.fg ? `.fg(${colorRust(node.style.fg, "Color::Blue", notes)})` : ".fg(Color::Blue)"}${node.style?.bg ? `.bg(${colorRust(node.style.bg, "Color::Reset", notes)})` : ""}.bold()))` +
          `.block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(${node.style?.fg ? colorRust(node.style.fg, "Color::Blue", notes) : "Color::Blue"})));`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
    case "input":
      out.push(
        `    // ${node.id}: input (one-line Paragraph; use tui-input for a real field)`,
        `    let ${varName} = Paragraph::new(${node.focused ? rustStr("▏") : rustStr("")})` +
          `.block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::DarkGray))` +
          (node.title ? `.title(${rustStr(node.title)})` : "") + `)${styleRust(node, notes)};`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
    case "grid": {
      const cols = node.data?.columns ?? [];
      const rows = node.data?.rows ?? [];
      const widths = cols.map(() => "Constraint::Percentage(25)").join(", ");
      const header = `Row::new(vec![${cols.map((c) => `Cell::from(${rustStr(c)})`).join(", ")}]).style(Style::default().fg(Color::DarkGray))`;
      const body = rows
        .map((row) => `            Row::new(vec![${row.map((c) => `Cell::from(${rustStr(c)})`).join(", ")}])`)
        .join(",\n");
      out.push(
        `    // ${node.id}: grid (${rows.length} rows) — L3: column widths are approximated (25% each), not derived from content`,
        `    let ${varName} = Table::new(`,
        `        vec![`,
        body || "            Row::new(vec![])",
        `        ],`,
        `        vec![${widths}],`,
        `    )`,
        `    .header(${header})`,
        `    .block(Block::default().borders(Borders::ALL)${node.title ? `.title(${rustStr(node.title)})` : ""});`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
    }
    case "statusbar":
      out.push(
        `    // ${node.id}: statusbar`,
        `    let ${varName} = Paragraph::new(${rustStr(node.content ?? "")})` +
          `${node.style?.bg ? `.style(Style::default().bg(${colorRust(node.style.bg, "Color::DarkGray", notes)}).fg(${colorRust(node.style.fg, "Color::White", notes)}))` : styleRust(node, notes, "Color::White")};`,
        `    f.render_widget(${varName}, ${rect});`,
      );
      break;
  }

  for (const child of node.children ?? []) emitNode(child, out, notes, varFor);
}

export function exportRatatui(spec: TuiSpec): string {
  const body: string[] = [];
  const notes: string[] = [];
  emitNode(spec.root, body, notes, makeVarNamer());
  const noteBlock =
    notes.length > 0
      ? notes.map((n) => `// NOTE: ${n}`).join("\n") + "\n"
      : "";
  return `// Generated by tui-live-design (ratatui export).
// Cell coordinates map 1:1 to Rect::new — layout is faithful; behavior is stubbed.
${noteBlock}use ratatui::{
  layout::{Constraint, Rect},
  style::{Color, Style},
  text::Span,
  widgets::{Block, Borders, Paragraph, Row, Table},
  Frame,
};

// Terminal was ${spec.term.cols}x${spec.term.rows} cells. Render against a full-area frame,
// or clamp/scale the rects if your runtime size differs.

pub fn draw(f: &mut Frame) {
${body.join("\n")}
}
`;
}
