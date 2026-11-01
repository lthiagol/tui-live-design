import type { TuiNode, TuiSpec } from "../shared/spec.js";

export interface ValidationResult {
  /** block the update */
  errors: string[];
  /** pass, but tell the agent */
  warnings: string[];
}

const KINDS = new Set([
  "root",
  "panel",
  "text",
  "button",
  "input",
  "grid",
  "statusbar",
]);

const MAX_DIM = 500;
// payload caps (M3/M5): keep specs renderable and screenshots cheap
const MAX_NODES = 2_000;
const MAX_CHILDREN = 100;
const MAX_CONTENT = 2_000;
const MAX_TITLE = 200;
const MAX_GRID_ROWS = 200;
const MAX_GRID_COLS = 20;
const MAX_GRID_CELL = 100;

// H2: colors must be safe to interpolate into SVG attributes
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_NAMES = new Set([
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "cyan", "magenta", "silver", "gold",
  "teal", "navy", "maroon", "olive", "lime", "aqua", "fuchsia",
  "lightgray", "lightgrey", "darkgray", "darkgrey", "lightblue", "darkred",
  "darkgreen", "transparent", "none",
]);

function checkColor(
  errors: string[],
  node: string,
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push(`node "${node}": style.${field} must be a string color`);
    return;
  }
  const v = value.toLowerCase().trim();
  if (!HEX_COLOR.test(v) && !COLOR_NAMES.has(v)) {
    errors.push(
      `node "${node}": style.${field} "${value}" is not a valid color (use #rgb/#rrggbb hex or a basic color name)`,
    );
  }
}

/**
 * Structural validation with actionable messages, so agents can
 * self-correct in one round trip.
 */
export function validateSpec(spec: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof spec !== "object" || spec === null) {
    return { errors: ["spec must be an object"], warnings };
  }
  const s = spec as TuiSpec;

  if (s.version !== 1) {
    errors.push(`spec.version must be 1, got ${JSON.stringify(s.version)}`);
  }
  const cols = s.term?.cols;
  const rows = s.term?.rows;
  if (!Number.isInteger(cols) || cols! < 1 || cols! > MAX_DIM) {
    errors.push(`term.cols must be an integer in 1..${MAX_DIM}, got ${JSON.stringify(cols)}`);
  }
  if (!Number.isInteger(rows) || rows! < 1 || rows! > MAX_DIM) {
    errors.push(`term.rows must be an integer in 1..${MAX_DIM}, got ${JSON.stringify(rows)}`);
  }
  if (errors.length > 0) return { errors, warnings };

  const ids = new Set<string>();
  let nodeCount = 0;
  const root = s.root;

  const walk = (
    node: unknown,
    parent: { id: string; rect: TuiNode["rect"] } | null,
    path: string,
  ): void => {
    if (typeof node !== "object" || node === null) {
      errors.push(`${path}: node must be an object`);
      return;
    }
    const n = node as TuiNode;

    if (typeof n.id !== "string" || n.id.length === 0) {
      errors.push(`${path}: missing required string "id"`);
      return;
    }
    if (ids.has(n.id)) {
      errors.push(`duplicate node id "${n.id}"`);
    }
    ids.add(n.id);
    if (++nodeCount > MAX_NODES) {
      errors.push(`spec exceeds ${MAX_NODES} nodes`);
      return; // stop walking; don't spam thousands of duplicate errors
    }

    if (typeof n.kind !== "string" || !KINDS.has(n.kind)) {
      errors.push(
        `node "${n.id}": unknown kind ${JSON.stringify(n.kind)} (expected one of ${[...KINDS].join(", ")})`,
      );
    }

    const r = n.rect;
    const rectOk =
      typeof r === "object" &&
      r !== null &&
      Number.isInteger(r.x) &&
      Number.isInteger(r.y) &&
      Number.isInteger(r.w) &&
      Number.isInteger(r.h);
    if (!rectOk) {
      errors.push(
        `node "${n.id}": rect must be integers {x, y, w, h}, got ${JSON.stringify(r)}`,
      );
      return; // can't bounds-check without a rect
    }
    if (r.w < 1 || r.h < 1) {
      errors.push(`node "${n.id}": rect must be at least 1x1, got ${r.w}x${r.h}`);
    }
    if (r.x < 0 || r.y < 0) {
      errors.push(`node "${n.id}": rect origin must be >= 0, got ${r.x},${r.y}`);
    }
    if (r.x + r.w > cols! || r.y + r.h > rows!) {
      errors.push(
        `node "${n.id}" (rect ${r.x},${r.y} ${r.w}x${r.h}) extends beyond the terminal (${cols}x${rows})`,
      );
    }
    if (parent && n.kind !== "root") {
      const p = parent.rect;
      if (
        r.x < p.x ||
        r.y < p.y ||
        r.x + r.w > p.x + p.w ||
        r.y + r.h > p.y + p.h
      ) {
        errors.push(
          `node "${n.id}" (rect ${r.x},${r.y} ${r.w}x${r.h}) is outside its parent "${parent.id}" (rect ${p.x},${p.y} ${p.w}x${p.h})`,
        );
      }
    }

    if (n.kind === "grid" && !n.data) {
      warnings.push(`node "${n.id}": grid without data renders empty`);
    }
    if (n.customHtml !== undefined && typeof n.customHtml !== "string") {
      errors.push(`node "${n.id}": customHtml must be a string`);
    }
    if (n.customHtml !== undefined && n.customHtml.length > 10_000) {
      errors.push(`node "${n.id}": customHtml too long (max 10000 chars)`);
    }
    if (n.children !== undefined && !Array.isArray(n.children)) {
      errors.push(`node "${n.id}": children must be an array`);
    }
    if (n.focused !== undefined && typeof n.focused !== "boolean") {
      errors.push(`node "${n.id}": focused must be a boolean`);
    }
    // L12: type-check every field the renderers touch
    if (n.title !== undefined && typeof n.title !== "string") {
      errors.push(`node "${n.id}": title must be a string`);
    } else if (typeof n.title === "string" && n.title.length > MAX_TITLE) {
      errors.push(`node "${n.id}": title too long (max ${MAX_TITLE} chars)`);
    }
    if (n.content !== undefined && typeof n.content !== "string") {
      errors.push(`node "${n.id}": content must be a string`);
    } else if (typeof n.content === "string" && n.content.length > MAX_CONTENT) {
      errors.push(`node "${n.id}": content too long (max ${MAX_CONTENT} chars)`);
    }
    if (n.annotation !== undefined && typeof n.annotation !== "string") {
      errors.push(`node "${n.id}": annotation must be a string`);
    }
    if (n.style !== undefined) {
      if (typeof n.style !== "object" || n.style === null) {
        errors.push(`node "${n.id}": style must be an object`);
      } else {
        checkColor(errors, n.id, "fg", (n.style as { fg?: unknown }).fg);
        checkColor(errors, n.id, "bg", (n.style as { bg?: unknown }).bg);
        for (const flag of ["bold", "dim"] as const) {
          const v = (n.style as Record<string, unknown>)[flag];
          if (v !== undefined && typeof v !== "boolean") {
            errors.push(`node "${n.id}": style.${flag} must be a boolean`);
          }
        }
      }
    }
    if (n.kind === "grid" && n.data) {
      const d = n.data as { columns?: unknown; rows?: unknown };
      if (!Array.isArray(d.columns) || d.columns.some((c) => typeof c !== "string")) {
        errors.push(`node "${n.id}": grid data.columns must be an array of strings`);
      } else if (d.columns.length > MAX_GRID_COLS) {
        errors.push(`node "${n.id}": grid has too many columns (max ${MAX_GRID_COLS})`);
      }
      if (!Array.isArray(d.rows) || d.rows.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== "string"))) {
        errors.push(`node "${n.id}": grid data.rows must be an array of arrays of strings`);
      } else if (d.rows.length > MAX_GRID_ROWS) {
        errors.push(`node "${n.id}": grid has too many rows (max ${MAX_GRID_ROWS})`);
      } else {
        for (const row of d.rows as string[][]) {
          for (const cell of row) {
            if (cell.length > MAX_GRID_CELL) {
              errors.push(`node "${n.id}": grid cell text too long (max ${MAX_GRID_CELL} chars)`);
              break;
            }
          }
        }
      }
    }

    // sibling overlap — legal for overlays, so warn (M5: capped by MAX_CHILDREN)
    const kids = n.children ?? [];
    if (kids.length > MAX_CHILDREN) {
      errors.push(`node "${n.id}": too many children (max ${MAX_CHILDREN})`);
    }
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i]?.rect;
        const b = kids[j]?.rect;
        if (a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          warnings.push(
            `siblings "${kids[i]!.id}" and "${kids[j]!.id}" overlap — fine for overlays, a bug otherwise`,
          );
        }
      }
      walk(kids[i], { id: n.id, rect: r }, `${path}.children[${i}]`);
    }
  };

  if (typeof root !== "object" || root === null) {
    errors.push("spec.root is required");
    return { errors, warnings };
  }
  if ((root as TuiNode).kind !== "root") {
    errors.push(`spec.root.kind must be "root", got ${JSON.stringify((root as TuiNode).kind)}`);
  }
  if (
    (root as TuiNode).rect &&
    ((root as TuiNode).rect.x !== 0 ||
      (root as TuiNode).rect.y !== 0 ||
      (root as TuiNode).rect.w !== cols ||
      (root as TuiNode).rect.h !== rows)
  ) {
    errors.push(
      `spec.root.rect must cover the whole terminal (0,0 ${cols}x${rows}), got ${JSON.stringify((root as TuiNode).rect)}`,
    );
  }
  walk(root, null, "root");

  return { errors, warnings };
}
