import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./session.js";
import { validateSpec, } from "./validate.js";
import { isValidDesignName } from "../shared/names.js";
import type { ServerMessage } from "../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, "../../sessions");

export interface SessionMeta {
  name: string;
  rev: number;
  savedAt: string;
}

/**
 * M9-lite: named design sessions.
 *
 * - Lazily materialized on first access (browser URL or MCP tool arg)
 * - Restored from sessions/<name>.json if present (spec + rev + revision
 *   notes + thread history + queued feedback)
 * - Autosaved atomically on every revision, serialized per session (R3-M2)
 *
 * This is the minimal cut: sessions are isolated from each other, but the
 * wire protocol still carries no session ids (that's M9-full, deferred).
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>();
  /** R3-H1: in-flight materializations — concurrent first access shares one promise */
  private inflight = new Map<string, Promise<Session>>();
  /** R3-M2: per-session save chain — renames can never land out of order */
  private saveQueue = new Map<string, Promise<void>>();

  constructor(
    private dir: string = SESSIONS_DIR,
    /** wired by the server: broadcast + autosave side effects */
    public onSessionMessage: (session: Session, msg: ServerMessage) => void = () => {},
  ) {}

  /** Sync access for already-materialized sessions (R3-L5 resync sweep). */
  peek(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  /** R3-C1: did this design ever get persisted? (migration guard) */
  async hasPersisted(name: string): Promise<boolean> {
    if (!isValidDesignName(name)) return false;
    try {
      await readFile(path.join(this.dir, `${name}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /** Auto-create on first access; restore from disk when a valid file exists. */
  async getOrCreate(name: string): Promise<Session> {
    if (!isValidDesignName(name)) {
      throw new Error(`invalid design name "${name}" (use lowercase letters, digits, - and _, max 40)`);
    }
    const existing = this.sessions.get(name);
    if (existing) return existing;

    const pending = this.inflight.get(name);
    if (pending) return pending;

    const promise = (async () => {
      const session = new Session(name);
      try {
        const raw = await readFile(path.join(this.dir, `${name}.json`), "utf8");
        const state = JSON.parse(raw);
        // R3-M1: restored specs go through the same validator as live edits
        const validation = validateSpec(state?.spec);
        if (validation.errors.length === 0) {
          session.restore(state);
        } else {
          console.error(
            `[registry] "${name}": saved state failed validation (${validation.errors[0]}) — starting fresh`,
          );
          await this.quarantine(name);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // R3-M1: a corrupt file is quarantined, not silently destroyed
          console.error(`[registry] "${name}": unreadable session file — starting fresh (${err instanceof Error ? err.message : err})`);
          await this.quarantine(name).catch(() => {});
        }
        // ENOENT = genuinely new design
      }
      session.onEmit = (msg) => this.onSessionMessage(session, msg);
      this.sessions.set(name, session);
      return session;
    })();

    this.inflight.set(name, promise);
    void promise.finally(() => this.inflight.delete(name));
    return promise;
  }

  /** R3-M1: move an unreadable/invalid session file aside instead of overwriting it. */
  private async quarantine(name: string): Promise<void> {
    try {
      await rename(
        path.join(this.dir, `${name}.json`),
        path.join(this.dir, `${name}.corrupt-${Date.now()}.json`),
      );
    } catch {
      // nothing to quarantine
    }
  }

  /** Metadata for the discovery endpoint/tool — head-read per file. */
  async list(): Promise<SessionMeta[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.includes(".corrupt-") && !f.includes(".tmp-")).sort();
    } catch {
      // dir missing — nothing persisted yet
    }
    const names = new Set([...files.map((f) => f.replace(/\.json$/, "")), ...this.sessions.keys(), "default"]);
    const out: SessionMeta[] = [];
    for (const name of [...names].sort()) {
      const live = this.sessions.get(name);
      if (live) {
        // R3-L6: distinguish "persisted" from "in memory only"
        const persisted = files.includes(`${name}.json`);
        out.push({ name, rev: live.rev, savedAt: persisted ? await this.headSavedAt(name) : "(in memory)" });
        continue;
      }
      try {
        const fh = await open(path.join(this.dir, `${name}.json`), "r");
        try {
          const buf = Buffer.alloc(256);
          const { bytesRead } = await fh.read(buf, 0, 256, 0);
          const head = buf.slice(0, bytesRead).toString("utf8");
          const rev = /"rev":\s*(\d+)/.exec(head)?.[1];
          out.push({
            name,
            rev: rev !== undefined ? Number(rev) : 0,
            savedAt: await this.headSavedAt(name),
          });
        } finally {
          await fh.close();
        }
      } catch {
        out.push({ name, rev: 0, savedAt: "(unreadable)" });
      }
    }
    return out;
  }

  private async headSavedAt(name: string): Promise<string> {
    try {
      const fh = await open(path.join(this.dir, `${name}.json`), "r");
      try {
        const buf = Buffer.alloc(128);
        const { bytesRead } = await fh.read(buf, 0, 128, 0);
        return /"savedAt":\s*"([^"]*)"/.exec(buf.slice(0, bytesRead).toString("utf8"))?.[1] ?? "(unknown)";
      } finally {
        await fh.close();
      }
    } catch {
      return "(unknown)";
    }
  }

  /** Atomic autosave of a session's full state, serialized per session (R3-M2). */
  save(session: Session): Promise<void> {
    if (!isValidDesignName(session.id)) return Promise.resolve();
    const prev = this.saveQueue.get(session.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // a failed save must not poison the chain
      .then(() => this.doSave(session));
    this.saveQueue.set(session.id, next);
    return next;
  }

  private async doSave(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    const fh = await open(tmp, "w");
    try {
      await fh.write(JSON.stringify(session.serialize(), null, 2));
      await fh.sync();
    } catch (err) {
      await unlink(tmp).catch(() => {}); // R3-M2: no .tmp litter
      throw err;
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  }
}
