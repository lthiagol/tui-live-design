import type { CellRect, TuiNode, TuiSpec } from "./spec.js";

/**
 * Plain-text renderer: the spec projected onto a character grid — the
 * "what it looks like" artifact for PRs/READMEs (preview.txt). Lossy by
 * design (no colors): the spec (design.json) remains the source of truth.
 */

export function renderSpecToText(spec: TuiSpec): string {
  const { cols, rows } = spec.term;
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(" "));

  const put = (x: number, y: number, s: string) => {
    if (y < 0 || y >= rows) return;
    for (let i = 0; i < s.length; i++) {
      const gx = x + i;
      if (gx >= 0 && gx < cols) grid[y]![gx] = s[i]!;
    }
  };

  const drawBox = (r: CellRect, title?: string) => {
    const { x, y, w, h } = r;
    if (w < 2 || h < 2) return;
    put(x, y, "┌");
    put(x + w - 1, y, "┐");
    put(x, y + h - 1, "└");
    put(x + w - 1, y + h - 1, "┘");
    for (let i = 1; i < w - 1; i++) {
      put(x + i, y, "─");
      put(x + i, y + h - 1, "─");
    }
    for (let j = 1; j < h - 1; j++) {
      put(x, y + j, "│");
      put(x + w - 1, y + j, "│");
    }
    if (title) put(x + 2, y, title);
  };

  const drawNode = (node: TuiNode) => {
    if (node.kind !== "root") {
      const { x, y, w, h } = node.rect;
      switch (node.kind) {
        case "panel":
          drawBox(node.rect, node.title);
          break;
        case "button": {
          const label = node.title ?? node.content ?? "";
          // don't double-bracket titles that already carry their own brackets
          const inner = label.startsWith("[") || label.endsWith("]") ? label : `[ ${label} ]`;
          const sx = x + Math.max(0, Math.floor((w - inner.length) / 2));
          const sy = y + Math.floor((h - 1) / 2);
          put(sx, sy, inner);
          break;
        }
        case "input": {
          drawBox(node.rect, node.title ?? ">");
          if (node.focused) put(x + 2, y + Math.floor((h - 1) / 2), "▏");
          break;
        }
        case "grid": {
          const colsData = node.data?.columns ?? [];
          const rowsData = node.data?.rows ?? [];
          if (colsData.length > 0) {
            const colX = (ci: number) => x + Math.floor((w * ci) / colsData.length);
            colsData.forEach((c, ci) => put(colX(ci) + 1, y + 1, c));
            for (let i = 1; i < w - 1; i++) put(x + i, y + 2, "─");
            rowsData.forEach((row, ri) => {
              row.forEach((cell, ci) => put(colX(ci) + 1, y + 3 + ri, cell));
            });
          }
          break;
        }
        case "statusbar":
          put(x, y, node.content ?? "");
          break;
        default:
          if (node.content) {
            (node.content ?? "").split("\n").forEach((line, li) => put(x, y + li, line));
          }
      }
    }
    for (const child of node.children ?? []) drawNode(child);
  };

  drawNode(spec.root);
  return grid.map((row) => row.join("").trimEnd()).join("\n");
}
