import { describe, it, expect } from "vitest";
import { Session } from "../src/server/session.js";
import { validateSpec } from "../src/server/validate.js";
import { applyPatchOps } from "../src/shared/patch.js";
import type { TuiSpec } from "../src/shared/spec.js";

/** A minimal valid spec for mutation tests. */
function makeSpec(): TuiSpec {
  return {
    version: 1,
    term: { cols: 80, rows: 24 },
    root: {
      id: "root",
      kind: "root",
      rect: { x: 0, y: 0, w: 80, h: 24 },
      children: [
        { id: "box", kind: "panel", rect: { x: 0, y: 0, w: 80, h: 3 }, title: " Box " },
        { id: "btn", kind: "button", rect: { x: 1, y: 1, w: 10, h: 1 }, title: "[ go ]" },
      ],
    },
  };
}

function sessionWith(spec: TuiSpec): Session {
  const s = new Session("test");
  const r = s.applyAgentUpdate({ spec, note: "seed" });
  if (!r.ok) throw new Error(r.error);
  return s;
}

describe("applyAgentUpdate (the single mutation funnel)", () => {
  it("applies a full spec and bumps the revision", () => {
    const s = sessionWith(makeSpec());
    const before = s.rev;
    const r = s.applyAgentUpdate({ spec: makeSpec(), note: "noop replace" });
    expect(r.ok).toBe(true);
    expect(s.rev).toBe(before + 1);
  });

  it("applies patch ops against the current spec", () => {
    const s = sessionWith(makeSpec());
    const r = s.applyAgentUpdate({ ops: [{ op: "move", id: "btn", x: 5, y: 2 }] });
    expect(r.ok).toBe(true);
    const btn = s.spec.root.children![1]!;
    expect(btn.rect.x).toBe(5);
    expect(btn.rect.y).toBe(2);
  });

  it("rejects when baseRev is stale (H4: no lost updates)", () => {
    const s = sessionWith(makeSpec());
    const r = s.applyAgentUpdate({ spec: makeSpec(), baseRev: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stale base");
  });

  it("accepts when baseRev matches", () => {
    const s = sessionWith(makeSpec());
    expect(s.applyAgentUpdate({ spec: makeSpec(), baseRev: s.rev }).ok).toBe(true);
  });

  it("runs validateSpec on every path — invalid specs are rejected with details", () => {
    const s = sessionWith(makeSpec());
    const bad = makeSpec();
    bad.root.children![1]!.rect = { x: 0, y: 0, w: 999, h: 1 };
    const r = s.applyAgentUpdate({ spec: bad });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("extends beyond the terminal");
  });

  it("returns validation warnings on success", () => {
    const s = sessionWith(makeSpec());
    const gridOnly = makeSpec();
    gridOnly.root.children!.push({
      id: "g", kind: "grid", rect: { x: 0, y: 5, w: 10, h: 5 },
    });
    const r = s.applyAgentUpdate({ spec: gridOnly });
    expect(r.ok).toBe(true);
    expect(r.warnings?.some((w) => w.includes("grid without data"))).toBe(true);
  });

  it("truncates over-long notes (R2-L9)", () => {
    const s = sessionWith(makeSpec());
    s.applyAgentUpdate({ spec: makeSpec(), note: "x".repeat(5000) });
    expect(s.revisions.at(-1)!.note.length).toBeLessThanOrEqual(200);
  });

  it("caps the revision ring at 100 (M2)", () => {
    const s = sessionWith(makeSpec());
    for (let i = 0; i < 120; i++) s.applyAgentUpdate({ spec: makeSpec(), note: `r${i}` });
    expect(s.revisions.length).toBeLessThanOrEqual(100);
  });

  it("keeps thread history bounded (200 entries)", () => {
    const s = sessionWith(makeSpec());
    for (let i = 0; i < 250; i++) s.addAgentMessage(`msg ${i}`, "note");
    expect(s.threadHistory.length).toBeLessThanOrEqual(200);
  });
});

describe("wait_for_feedback queue (H1/R2-H1)", () => {
  it("delivers the whole pending batch atomically to exactly one waiter (FIFO)", async () => {
    const s = sessionWith(makeSpec());
    const p1 = s.waitForFeedback(1000);
    const p2 = s.waitForFeedback(1000);
    s.handleUserMessage({ selection: [], text: "batch" });
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.timedOut).toBe(false);
    expect(r1.messages).toHaveLength(1);
    expect(r2.timedOut).toBe(true); // second waiter waits its turn
  });

  it("a timing-out waiter leaves the queue without draining messages", async () => {
    const s = sessionWith(makeSpec());
    const p1 = s.waitForFeedback(30); // will time out first
    await new Promise((r) => setTimeout(r, 50));
    const p2 = s.waitForFeedback(2000);
    s.handleUserMessage({ selection: [], text: "for the live waiter" });
    expect((await p1).timedOut).toBe(true);
    const r2 = await p2;
    expect(r2.messages.map((m) => m.text)).toEqual(["for the live waiter"]);
  });

  it("cancelling (agent death) removes the waiter before it can eat a batch", async () => {
    const s = sessionWith(makeSpec());
    const ac = new AbortController();
    const p1 = s.waitForFeedback(10_000, ac.signal);
    ac.abort();
    const r1 = await p1;
    expect(r1.timedOut).toBe(true);
    // the cancelled waiter must NOT consume the next batch
    const p2 = s.waitForFeedback(2000);
    s.handleUserMessage({ selection: [], text: "not lost" });
    expect((await p2).messages).toHaveLength(1);
  });

  it("liveness polling cancels a waiter whose request socket died", async () => {
    const s = sessionWith(makeSpec());
    let alive = true;
    const p = s.waitForFeedback(10_000, undefined, () => alive, 20);
    alive = false; // simulate connection death
    const r = await p;
    expect(r.timedOut).toBe(true);
  });

  it("messages accumulate when no agent is waiting — nothing is lost", async () => {
    const s = sessionWith(makeSpec());
    s.handleUserMessage({ selection: [], text: "queued 1" });
    s.handleUserMessage({ selection: [], text: "queued 2" });
    const r = await s.waitForFeedback(100);
    expect(r.messages.map((m) => m.text)).toEqual(["queued 1", "queued 2"]);
  });

  it("queue cap: rejects beyond 50 pending (R2-M4)", () => {
    const s = sessionWith(makeSpec());
    for (let i = 0; i < 50; i++) s.handleUserMessage({ selection: [], text: `m${i}` });
    expect(() => s.handleUserMessage({ selection: [], text: "one too many" })).toThrow(/queue full/);
  });

  it("validates message shape and caps (H5/M6)", () => {
    const s = sessionWith(makeSpec());
    expect(() => s.handleUserMessage({ text: "hi" })).toThrow(); // no selection
    expect(() => s.handleUserMessage({ selection: "nope", text: "hi" })).toThrow();
    expect(() => s.handleUserMessage({ selection: [], text: "x".repeat(9000) })).toThrow(/too long/);
    // junk entries are DROPPED, not crashed on: bad rects and rect-less ids
    const ok = s.handleUserMessage({
      selection: [{ elementId: "a", rect: { x: "NaN", y: 0, w: 1, h: 1 } }, { elementId: "b" }],
      text: "hi",
    });
    expect(ok.selection).toHaveLength(0);
  });
});
