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
    await expect(registry.getOrCreate("NoUppercase")).rejects.toThrow(/invalid design name/); // R3-M6
  });

  it("concurrent first access yields ONE instance (R3-H1, demonstrated split-brain)", async () => {
    const { registry } = makeRegistry();
    const [a, b] = await Promise.all([
      registry.getOrCreate("race-test"),
      registry.getOrCreate("race-test"),
    ]);
    expect(a).toBe(b); // same object — no split-brain
  });

  it("corrupt session files are quarantined, not silently destroyed (R3-M1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tui-reg-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "broken.json"), "{ not json");
    const reg = new SessionRegistry(dir);
    const s = await reg.getOrCreate("broken"); // falls back to sample, logs
    expect(s.rev).toBe(0);
    const files = await import("node:fs/promises").then((m) => m.readdir(dir));
    expect(files.some((f) => f.startsWith("broken.corrupt-"))).toBe(true); // preserved
    expect(files).not.toContain("broken.json"); // won't be overwritten
  });

  it("migration guard: legacy autosave never clobbers a migrated session (R3-C1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tui-reg-"));
    const reg = new SessionRegistry(dir);
    const s = await reg.getOrCreate("default");
    const bigger = structuredClone(s.spec);
    bigger.term = { cols: 90, rows: 26 };
    bigger.root.rect = { x: 0, y: 0, w: 90, h: 26 };
    s.applyAgentUpdate({ spec: bigger, note: "migrated work" });
    await reg.save(s);
    expect(await reg.hasPersisted("default")).toBe(true);

    // a boot-migration attempt must NOT restore stale legacy state over it
    const legacyState = { savedAt: "old", rev: 1, spec: makeSampleLike() };
    if (!(await reg.hasPersisted("default"))) {
      s.restore(legacyState);
      await reg.save(s);
    }
    const after = await reg.getOrCreate("default");
    expect(after.spec.term).toEqual({ cols: 90, rows: 26 }); // newer work kept
  });
});

function makeSampleLike() {
  return {
    version: 1 as const,
    term: { cols: 80, rows: 24 },
    root: { id: "root", kind: "root" as const, rect: { x: 0, y: 0, w: 80, h: 24 }, children: [] },
  };
}
