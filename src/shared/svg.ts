import type { TuiNode, TuiSpec } from "./spec.js";
import { themeByName } from "./themes.js";

/**
 * Deterministic spec → SVG renderer. Mirrors the DOM renderer's cell math
 * so it can run server-side with no browser: used for the get_screenshot
 * MCP tool (rasterized to PNG) and later for SVG exports.
 *
 * Text-bearing nodes are clipped to their rect (L8) so the screenshot
 * matches what the DOM renderer shows — overflow doesn't spill on neighbors.
 */

export interface ThemeColors {
  bg: string;
  fg: string;
  border: string;
  accent: string;
  dim: string;
}

export const DEFAULT_THEME: ThemeColors = {
  bg: "#24283b",
  fg: "#c0caf5",
  border: "#414868",
  accent: "#7aa2f7",
  dim: "#565f89",
};

const CW = 10; // cell width, px
const CH = 18; // cell height, px
const FONT = "Menlo, Monaco, DejaVu Sans Mono, monospace";
const BASELINE = 13; // text baseline within a cell

interface RenderCtx {
  /** accumulated <clipPath> defs (L8) */
  defs: string[];
  /** per-render clip id counter */
  clipSeq: number;
  /** returns a clip-path reference constraining text to the node's rect */
  clipFor: (node: TuiNode) => string;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Escape for attribute context — colors come from the spec, so escape defensively (H2). */
function attr(s: string): string {
  return esc(s);
}

function textAt(x: number, y: number, ch: string, color: string, bold: boolean): string {
  return `<text x="${x}" y="${y}" fill="${attr(color)}" font-family="${FONT}" font-size="14"${bold ? ' font-weight="700"' : ""}>${esc(ch)}</text>`;
}

function clipDef(node: TuiNode, ctx: RenderCtx): string {
  const { x, y, w, h } = node.rect;
  const id = `clip-${ctx.clipSeq++}`;
  ctx.defs.push(
    `<clipPath id="${id}"><rect x="${x * CW}" y="${y * CH}" width="${w * CW}" height="${h * CH}"/></clipPath>`,
  );
  return `url(#${id})`;
}

/** Render each visible character at its exact cell position — grid-perfect. */
function textBlock(
  node: { rect: { x: number; y: number }; content?: string; style?: { fg?: string; bold?: boolean } },
  theme: ThemeColors,
  padX = 0,
): string {
  const out: string[] = [];
  const color = node.style?.fg ?? theme.fg;
  const bold = node.style?.bold ?? false;
  const lines = (node.content ?? "").split("\n");
  lines.forEach((line, li) => {
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci]!;
      if (ch === " ") continue;
      out.push(
        textAt((node.rect.x + padX + ci) * CW, (node.rect.y + li) * CH + BASELINE, ch, color, bold),
      );
    }
  });
  return out.join("");
}

function renderNode(node: TuiNode, theme: ThemeColors, ctx: RenderCtx): string {
  const { x, y, w, h } = node.rect;
  const parts: string[] = [];
  const textParts: string[] = []; // clipped to the node's rect (L8)

  if (node.style?.bg) {
    parts.push(
      `<rect x="${x * CW}" y="${y * CH}" width="${w * CW}" height="${h * CH}" fill="${attr(node.style.bg)}"/>`,
    );
  }

  switch (node.kind) {
    case "panel":
      parts.push(
        `<rect x="${x * CW + 0.5}" y="${y * CH + 0.5}" width="${w * CW - 1}" height="${h * CH - 1}" fill="none" stroke="${attr(theme.border)}" stroke-width="1" rx="2"/>`,
      );
      if (node.title) {
        // titles intentionally sit ON the border — not clipped
        const tx = (x + 2) * CW;
        const ty = y * CH;
        parts.push(
          `<rect x="${tx - 3}" y="${ty - 5}" width="${node.title.length * 7.5 + 6}" height="12" fill="${theme.bg}"/>`,
          textAt(tx, ty + BASELINE - 4, node.title, theme.accent, false),
        );
      }
      break;
    case "button": {
      parts.push(
        `<rect x="${x * CW + 0.5}" y="${y * CH + 0.5}" width="${w * CW - 1}" height="${h * CH - 1}" fill="none" stroke="${attr(theme.accent)}" rx="2"/>`,
      );
      const label = node.title ?? node.content ?? "";
      if (label) {
        const cx = (x + w / 2) * CW;
        const sx = cx - (label.length * CW) / 2;
        textParts.push(
          textAt(Math.round(sx * 10) / 10, (y + (h - 1) / 2) * CH + BASELINE, label, node.style?.fg ?? theme.accent, true),
        );
      }
      break;
    }
    case "input": {
      parts.push(
        `<rect x="${x * CW + 0.5}" y="${y * CH + 0.5}" width="${w * CW - 1}" height="${h * CH - 1}" fill="none" stroke="${attr(theme.dim)}" rx="2"/>`,
      );
      const label = node.title ?? ">";
      textParts.push(textAt((x + 1) * CW, (y + 0.5) * CH + BASELINE - 2, label, theme.accent, false));
      if (node.focused) {
        const caretX = (x + 1 + label.length + 1) * CW;
        textParts.push(textAt(caretX, (y + 0.5) * CH + BASELINE - 2, "▏", theme.fg, false));
      }
      break;
    }
    case "grid": {
      const cols = node.data?.columns ?? [];
      const nrows = node.data?.rows ?? [];
      if (cols.length > 0) {
        const colX = (ci: number) => x + Math.floor((w * ci) / cols.length);
        cols.forEach((c, ci) => {
          for (let k = 0; k < c.length; k++) {
            textParts.push(
              textAt((colX(ci) + 1 + k) * CW, (y + 1) * CH + BASELINE, c[k]!, theme.dim, true),
            );
          }
        });
        parts.push(
          `<line x1="${x * CW}" y1="${(y + 2) * CH}" x2="${(x + w) * CW}" y2="${(y + 2) * CH}" stroke="${attr(theme.border)}"/>`,
        );
        nrows.forEach((row, ri) => {
          row.forEach((cell, ci) => {
            for (let k = 0; k < cell.length; k++) {
              textParts.push(
                textAt((colX(ci) + 1 + k) * CW, (y + 3 + ri) * CH + BASELINE, cell[k]!, theme.fg, false),
              );
            }
          });
        });
      }
      break;
    }
    case "statusbar":
      if (node.content) {
        for (let ci = 0; ci < node.content.length; ci++) {
          const ch = node.content[ci]!;
          if (ch === " ") continue;
          textParts.push(textAt((x + ci) * CW, (y + 0.5) * CH + BASELINE - 2, ch, node.style?.fg ?? theme.fg, false));
        }
      }
      break;
    default:
      textParts.push(textBlock(node, theme));
  }

  if (textParts.length > 0) {
    parts.push(`<g clip-path="${ctx.clipFor(node)}">${textParts.join("")}</g>`);
  }

  for (const child of node.children ?? []) {
    parts.push(renderNode(child, theme, ctx));
  }
  return parts.join("");
}

export function renderSpecToSvg(
  spec: TuiSpec,
  opts: { theme?: ThemeColors; scale?: number } = {},
): string {
  const theme = opts.theme ?? themeByName(spec.theme).colors;
  const scale = opts.scale ?? 2;
  const w = spec.term.cols * CW;
  const h = spec.term.rows * CH;
  const ctx: RenderCtx = {
    defs: [],
    clipSeq: 0,
    clipFor: (node) => clipDef(node, ctx),
  };
  const body = renderNode(spec.root, theme, ctx);
  const defs = ctx.defs.length > 0 ? `<defs>${ctx.defs.join("")}</defs>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    defs +
    `<rect width="${w}" height="${h}" fill="${theme.bg}"/>` +
    body +
    `</svg>`
  );
}
