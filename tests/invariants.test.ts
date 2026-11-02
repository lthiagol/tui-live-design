import { describe, it, expect } from "vitest";
import { validateSpec } from "../src/server/validate.js";
import { applyPatchOps } from "../src/shared/patch.js";
import { renderSpecToText } from "../src/shared/text.js";
import { renderSpecToSvg } from "../src/shared/svg.js";
import { exportRatatui } from "../src/server/export/ratatui.js";
import { isAuthorized } from "../src/server/auth.js";
import { saveDesign, loadDesign, listDesigns } from "../src/server/storage.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { TuiSpec } from "../src/shared/spec.js";

function makeSpec(): TuiSpec {
  return {
    version: 1,
    term: { cols: 80, rows: 24 },
    root: {
      id: "root", kind: "root", rect: { x: 0, y: 0, w: 80, h: 24 },
      children: [
        { id: "box", kind: "panel", rect: { x: 0, y: 0, w: 40, h: 3 }, title: " Box " },
        { id: "btn", kind: "button", rect: { x: 1, y: 1, w: 8, h: 1 }, title: "[ go ]" },
      ],
    },
  };
}

function reqWith(headers: Record<string, string>, url: string): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe("validateSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateSpec(makeSpec()).errors).toHaveLength(0);
  });

  it("rejects out-of-bounds nodes with actionable errors", () => {
    const s = makeSpec();
    s.root.children![0]!.rect = { x: 75, y: 0, w: 10, h: 1 };
    const v = validateSpec(s);
    expect(v.errors.some((e) => e.includes("extends beyond the terminal"))).toBe(true);
  });

  it("rejects children outside their parent", () => {
    const s = makeSpec();
    s.root.children = [{
      id: "panel", kind: "panel", rect: { x: 0, y: 0, w: 10, h: 5 },
      children: [{ id: "inner", kind: "text", rect: { x: 20, y: 1, w: 5, h: 1 } }],
    }];
    expect(validateSpec(s).errors.some((e) => e.includes("outside its parent"))).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const s = makeSpec();
    s.root.children!.push({ ...s.root.children![0]! });
    expect(validateSpec(s).errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects hostile colors (H2)", () => {
    const s = makeSpec();
    s.root.children![0]!.style = { fg: 'red"><script>' };
    const v = validateSpec(s);
    expect(v.errors.some((e) => e.includes("not a valid color"))).toBe(true);
    // known-good forms pass
    s.root.children![0]!.style = { fg: "#a6e3a1", bg: "blue" };
    expect(validateSpec(s).errors).toHaveLength(0);
  });

  it("enforces size caps (M3/M5)", () => {
    const s = makeSpec();
    s.root.children![0]!.content = "x".repeat(3000);
    expect(validateSpec(s).errors.some((e) => e.includes("content too long"))).toBe(true);

    const big = makeSpec();
    big.root.children = Array.from({ length: 150 }, (_, i) => ({
      id: `n${i}`, kind: "text" as const, rect: { x: 0, y: 0, w: 1, h: 1 },
    }));
    expect(validateSpec(big).errors.some((e) => e.includes("too many children"))).toBe(true);
  });

  it("type-checks renderable fields (L12)", () => {
    const s = makeSpec();
    (s.root.children![0] as Record<string, unknown>).title = 42;
    expect(validateSpec(s).errors.some((e) => e.includes("title must be a string"))).toBe(true);
  });
});

describe("patch ops", () => {
  it("move/resize/set_text/set_style/focus/annotate/delete/add all work", () => {
    const spec = makeSpec();
    const r = applyPatchOps(spec, [
      { op: "move", id: "btn", x: 2, y: 2 },
      { op: "resize", id: "btn", w: 12, h: 1 },
      { op: "set_text", id: "btn", title: "[ run ]" },
      { op: "set_style", id: "btn", style: { fg: "#ff0000" } },
      { op: "focus", id: "btn" },
      { op: "annotate", id: "btn", text: "the go button" },
      { op: "add", parent: "root", node: { id: "extra", kind: "text", rect: { x: 0, y: 5, w: 5, h: 1 } } },
    ]);
    expect(r.ok).toBe(true);
    const btn = r.spec!.root.children![1]!; // index 1: [box, btn]
    expect(btn.rect).toEqual({ x: 2, y: 2, w: 12, h: 1 });
    expect(btn.title).toBe("[ run ]");
    expect(btn.style?.fg).toBe("#ff0000");
    expect(btn.focused).toBe(true);
    expect(btn.annotation).toBe("the go button");
    expect(r.spec!.root.children!.some((c) => c.id === "extra")).toBe(true);

    const del = applyPatchOps(r.spec!, [{ op: "delete", id: "extra" }]);
    expect(del.ok).toBe(true);
    expect(del.spec!.root.children!.some((c) => c.id === "extra")).toBe(false);
  });

  it("fails cleanly on unknown ids and root protection", () => {
    expect(applyPatchOps(makeSpec(), [{ op: "move", id: "ghost", x: 0, y: 0 }]).ok).toBe(false);
    expect(applyPatchOps(makeSpec(), [{ op: "delete", id: "root" }]).error).toContain("root");
    expect(applyPatchOps(makeSpec(), [{ op: "add", parent: "ghost", node: { id: "x", kind: "text", rect: { x: 0, y: 0, w: 1, h: 1 } } }]).error).toContain("not found");
  });
});

describe("renderers", () => {
  it("text renderer draws panels, buttons and content on the grid", () => {
    const txt = renderSpecToText(makeSpec());
    expect(txt).toContain("┌");
    expect(txt).toContain("[ go ]");
    const lines = txt.split("\n");
    expect(lines).toHaveLength(24);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });

  it("svg renderer emits escaped, clipped output", () => {
    const s = makeSpec();
    s.root.children![1]!.style = { fg: "#ff0000" };
    s.root.children!.push({
      id: "txt", kind: "text", rect: { x: 0, y: 5, w: 10, h: 1 }, content: "a<b & c",
    });
    const svg = renderSpecToSvg(s, { scale: 2 });
    expect(svg).toContain("&lt;"); // < escaped
    expect(svg).toContain("&amp;"); // & escaped
    expect(svg).not.toContain("<b>"); // no raw injected tag
    expect(svg).toContain("clip-path=");
    expect(svg).toContain("<defs>");
  });

  it("ratatui export: unique, keyword-safe, prefixed identifiers (L1)", () => {
    const s = makeSpec();
    s.root.children!.push(
      { id: "type", kind: "text", rect: { x: 0, y: 5, w: 5, h: 1 }, content: "kw" },
      { id: "a-b", kind: "text", rect: { x: 0, y: 6, w: 5, h: 1 }, content: "one" },
      { id: "a_b", kind: "text", rect: { x: 0, y: 7, w: 5, h: 1 }, content: "two" },
    );
    const code = exportRatatui(s);
    const vars = [...code.matchAll(/let (n_[a-zA-Z0-9_]+)/g)].map((m) => m[1]!);
    expect(new Set(vars).size).toBe(vars.length);
    expect(vars).toContain("n_type");
    expect(vars).toContain("n_a_b");
    expect(vars).toContain("n_a_b_2");
  });
});

describe("auth (C1)", () => {
  const token = "secret-token-123";
  it("accepts bearer, header and query; rejects the rest", () => {
    expect(isAuthorized(reqWith({ authorization: `Bearer ${token}` }, "/api/spec"), new URL("http://x/api/spec"), token)).toBe(true);
    expect(isAuthorized(reqWith({ "x-tui-token": token }, "/api/spec"), new URL("http://x/api/spec"), token)).toBe(true);
    expect(isAuthorized(reqWith({}, "/api/spec?token=" + token), new URL("http://x/api/spec?token=" + token), token)).toBe(true);
    expect(isAuthorized(reqWith({}, "/api/spec"), new URL("http://x/api/spec"), token)).toBe(false);
    expect(isAuthorized(reqWith({ authorization: "Bearer wrong" }, "/api/spec"), new URL("http://x/api/spec"), token)).toBe(false);
    expect(isAuthorized(reqWith({ authorization: `Bearer ${token}-x` }, "/api/spec"), new URL("http://x/api/spec"), token)).toBe(false);
  });
});

describe("storage (L4)", () => {
  it("atomic save → load round trip; list reads metadata; bad names rejected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tui-test-"));
    const spec = makeSpec();
    await saveDesign(spec, 7, "demo", dir);
    const loaded = await loadDesign("demo", dir);
    expect(loaded.rev).toBe(7);
    expect(loaded.spec).toEqual(spec);
    const listed = await listDesigns(dir);
    expect(listed).toEqual([{ name: "demo", savedAt: expect.any(String), rev: 7 }]);
    await expect(saveDesign(spec, 1, "../evil", dir)).rejects.toThrow(/invalid design name/);
  });
});
