import type { TuiNode, TuiSpec, TuiStyle } from "./spec.js";

/**
 * Patch operations — small targeted edits instead of full-spec rewrites.
 * Cheaper for agents and impossible to accidentally revert unrelated work.
 */
export type PatchOp =
  | { op: "move"; id: string; x: number; y: number }
  | { op: "resize"; id: string; w: number; h: number }
  | { op: "set_text"; id: string; text?: string; title?: string }
  | { op: "set_style"; id: string; style: TuiStyle | null }
  | { op: "focus"; id: string }
  | { op: "annotate"; id: string; text: string | null }
  | { op: "delete"; id: string }
  | { op: "add"; parent: string; node: TuiNode };

export interface PatchResult {
  ok: boolean;
  spec?: TuiSpec;
  error?: string;
}

/** Depth-first visit; return "stop" from fn to halt the walk. */
function visit(
  node: TuiNode,
  fn: (n: TuiNode, parent: TuiNode | null) => "stop" | void,
  parent: TuiNode | null = null,
): "stop" | void {
  if (fn(node, parent) === "stop") return "stop";
  for (const child of node.children ?? []) {
    if (visit(child, fn, node) === "stop") return "stop";
  }
}

function findById(root: TuiNode, id: string): TuiNode | undefined {
  let found: TuiNode | undefined;
  visit(root, (n) => {
    if (n.id === id) {
      found = n;
      return "stop";
    }
  });
  return found;
}

/** Apply ops to a deep clone of the spec; the input is never mutated. */
export function applyPatchOps(spec: TuiSpec, ops: PatchOp[]): PatchResult {
  let next: TuiSpec;
  try {
    next = structuredClone(spec);
  } catch (err) {
    return { ok: false, error: `spec not cloneable: ${err}` };
  }

  for (const [i, op] of ops.entries()) {
    const where = `ops[${i}] (${op.op})`;

    if (op.op === "add") {
      if (!op.parent || !op.node?.id || !op.node?.kind || !op.node?.rect) {
        return { ok: false, error: `${where}: requires parent + node with id, kind and rect` };
      }
      const parent = findById(next.root, op.parent);
      if (!parent) return { ok: false, error: `${where}: parent id "${op.parent}" not found` };
      (parent.children ??= []).push(structuredClone(op.node));
      continue;
    }

    const target = findById(next.root, op.id);
    if (!target) return { ok: false, error: `${where}: id "${op.id}" not found` };
    if (target.kind === "root" && op.op !== "focus") {
      return { ok: false, error: `${where}: cannot modify the root node` };
    }

    switch (op.op) {
      case "move":
        target.rect = { ...target.rect, x: op.x, y: op.y };
        break;
      case "resize":
        target.rect = { ...target.rect, w: op.w, h: op.h };
        break;
      case "set_text":
        if (op.text !== undefined) target.content = op.text;
        if (op.title !== undefined) target.title = op.title;
        break;
      case "set_style":
        target.style = op.style === null ? undefined : op.style;
        break;
      case "focus":
        visit(next.root, (n) => {
          if (n.focused) n.focused = false;
          if (n.id === op.id) n.focused = true;
        });
        break;
      case "annotate":
        target.annotation = op.text === null ? undefined : op.text;
        break;
      case "delete": {
        let removed = false;
        visit(next.root, (n) => {
          const kids = n.children;
          if (kids) {
            const idx = kids.findIndex((c) => c.id === op.id);
            if (idx >= 0) {
              kids.splice(idx, 1);
              removed = true;
            }
          }
        });
        if (!removed) return { ok: false, error: `${where}: id "${op.id}" is not a child of any node` };
        break;
      }
    }
  }

  return { ok: true, spec: next };
}
