import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../src/server/registry.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function makeRegistry() {
  const broadcasts: Array<{ design: string; type: string }> = [];
  const registry = new SessionRegistry(undefined, (session, msg) => {
    broadcasts.push({ design: session.id, type: msg.type });
  });
  return { registry, broadcasts };
}

describe("SessionRegistry (M9-lite)", () => {
  it("sessions are isolated: messages and specs never cross", async () => {
    const { registry, broadcasts } = makeRegistry();
    const a = await registry.getOrCreate("alpha");
    const b = await registry.getOrCreate("beta");

    a.handleUserMessage({ selection: [], text: "for alpha only" });

    expect(a.rev).toBe(0);
    expect(b.rev).toBe(0);

    const ra = a.applyAgentUpdate({
      ops: [{ op: "set_text", id: "header-title", text: "alpha was here" }],
      note: "a edit",
    });
    expect(ra.ok).toBe(true);
    expect(a.rev).toBe(1);
    expect(b.rev).toBe(0); // beta untouched
    expect(b.spec.root.children![0]!.children![0]!.content).not.toBe("alpha was here");

    // broadcasts are scoped by design name
    const specBroadcasts = broadcasts.filter((m) => m.type === "spec");
    expect(specBroadcasts.map((m) => m.design)).toEqual(["alpha"]);

    // queues are per-session: alpha's pending message can't reach beta
    const rb = await b.waitForFeedback(50);
    expect(rb.timedOut).toBe(true);
    const ra2 = await a.waitForFeedback(100);
    expect(ra2.messages[0]!.text).toBe("for alpha only");
  });

  it("auto-creates on first access with the sample spec", async () => {
    const { registry } = makeRegistry();
    const fresh = await registry.getOrCreate("brand-new");
    expect(fresh.rev).toBe(0);
    expect(fresh.spec.root.id).toBe("root");
  });

  it("persists and restores spec + rev + thread across registries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tui-reg-"));
    const { registry } = makeRegistry();
    // override dir
    const reg = new SessionRegistry(dir);
    const s = await reg.getOrCreate("proj");
    const bigger = structuredClone(s.spec);
    bigger.term = { cols: 100, rows: 30 };
    bigger.root.rect = { x: 0, y: 0, w: 100, h: 30 };
    s.applyAgentUpdate({ spec: bigger, note: "bigger term" });
    s.handleUserMessage({ selection: [], text: "user said something" });
    s.addAgentMessage("agent replied", "note");
    await reg.save(s); // production does this via onSessionMessage on every rev

    // a second registry instance (simulating restart) restores it
    const reg2 = new SessionRegistry(dir);
    const restored = await reg2.getOrCreate("proj");
    expect(restored.spec.term).toEqual({ cols: 100, rows: 30 });
    expect(restored.rev).toBe(1);
    expect(restored.threadHistory.map((m) => m.text)).toEqual([
      "user said something",
      "agent replied",
    ]);
    // revision notes survive for notes.md
    expect(restored.revisions.some((r) => r.note === "bigger term")).toBe(true);
  });

  it("list() includes persisted and live sessions plus default", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tui-reg-"));
    const reg = new SessionRegistry(dir);
    await (await reg.getOrCreate("one")).applyAgentUpdate({ ops: [{ op: "focus", id: "btn-approve" }] });
    await reg.save(await reg.getOrCreate("one"));
    const listed = await reg.list();
    const names = listed.map((m) => m.name);
    expect(names).toContain("one");
    expect(names).toContain("default");
  });

  it("rejects invalid names (path-traversal safe)", async () => {
    const { registry } = makeRegistry();
    await expect(registry.getOrCreate("../evil")).rejects.toThrow(/invalid design name/);
    await expect(registry.getOrCreate("")).rejects.toThrow(/invalid design name/);
  });
});
