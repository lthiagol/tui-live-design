import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./session.js";
import type { ServerMessage } from "../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, "../../sessions");

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

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
 *   notes + thread history)
 * - Autosaved atomically on every revision
 *
 * This is the minimal cut: sessions are isolated from each other, but the
 * wire protocol still carries no session ids (that's M9-full, deferred).
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>();

  constructor(
    private dir: string = SESSIONS_DIR,
    /** wired by the server: broadcast + autosave side effects */
    public onSessionMessage: (session: Session, msg: ServerMessage) => void = () => {},
  ) {}

  /** Sync access for already-materialized sessions (routing fast-paths). */
  peek(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  /** Auto-create on first access; restore from disk when it exists. */
  async getOrCreate(name: string): Promise<Session> {
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid design name "${name}" (use letters, digits, - and _, max 40)`);
    }
    const existing = this.sessions.get(name);
    if (existing) return existing;

    const session = new Session(name);
    try {
      const raw = await readFile(path.join(this.dir, `${name}.json`), "utf8");
      session.restore(JSON.parse(raw));
    } catch {
      // no saved state — fresh session (sample spec)
    }
    session.onEmit = (msg) => this.onSessionMessage(session, msg);
    this.sessions.set(name, session);
    return session;
  }

  /** All materialized session names, including "default" implicitly. */
  names(): string[] {
    return [...new Set([...this.sessions.keys(), "default"])];
  }

  /** Metadata for the discovery endpoint/tool — head-read per file. */
  async list(): Promise<SessionMeta[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      // dir missing — nothing persisted yet
    }
    const names = new Set([...files.map((f) => f.replace(/\.json$/, "")), ...this.sessions.keys(), "default"]);
    const out: SessionMeta[] = [];
    for (const name of [...names].sort()) {
      const live = this.sessions.get(name);
      if (live) {
        out.push({ name, rev: live.rev, savedAt: new Date().toISOString() });
        continue;
      }
      try {
        const fh = await open(path.join(this.dir, `${name}.json`), "r");
        try {
          const buf = Buffer.alloc(256);
          const { bytesRead } = await fh.read(buf, 0, 256, 0);
          const head = buf.slice(0, bytesRead).toString("utf8");
          const rev = /"rev":\s*(\d+)/.exec(head)?.[1];
          const savedAt = /"savedAt":\s*"([^"]*)"/.exec(head)?.[1];
          out.push({
            name,
            rev: rev !== undefined ? Number(rev) : 0,
            savedAt: savedAt ?? "(unknown)",
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

  /** Atomic autosave of a session's full state. */
  async save(session: Session): Promise<void> {
    if (!NAME_RE.test(session.id)) return;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    const fh = await open(tmp, "w");
    try {
      await fh.write(JSON.stringify(session.serialize(), null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  }
}
