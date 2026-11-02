import { randomUUID } from "node:crypto";
import { applyPatchOps, type PatchOp } from "../shared/patch.js";
import { validateSpec } from "./validate.js";
import type {
  AgentMessage,
  AgentMessageKind,
  CellRect,
  ClientMessage,
  NodeKind,
  Revision,
  SelectionRef,
  ServerMessage,
  TuiSpec,
  UserMessage,
} from "../shared/spec.js";
import { SAMPLE_SPEC } from "../shared/sample.js";

// ---- protocol limits (H5/M6): reject junk instead of fanning it out
const MAX_MESSAGE_TEXT = 8_000;
const MAX_SELECTION = 100;
const MAX_REGIONS = 20;
const MAX_SEND_MESSAGE = 16_000;
const MAX_REVISIONS = 100;
const MAX_PENDING_MESSAGES = 50;
const MAX_NOTE = 200;

const KINDS = new Set<string>([
  "root", "panel", "text", "button", "input", "grid", "statusbar",
]);

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= -1000 && v <= 5000 ? v : null;
}

function parseRect(v: unknown): CellRect | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const x = asInt(r.x), y = asInt(r.y), w = asInt(r.w), h = asInt(r.h);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

/** One blocked wait_for_feedback consumer. Exactly one waiter receives each batch. */
interface Waiter {
  deliver: (messages: UserMessage[]) => void;
  cancel: () => void;
}

export interface AgentUpdateInput {
  spec?: unknown;
  ops?: PatchOp[];
  note?: string;
  /** optimistic concurrency: reject if the design moved since the agent read it */
  baseRev?: number;
}

export interface AgentUpdateResult {
  ok: boolean;
  rev?: number;
  warnings?: string[];
  error?: string;
}

/**
 * The design session: current spec, revision history, and the message
 * thread between the user (browser) and any connected agent.
 *
 * All state changes flow out through `onEmit` — a single broadcast
 * channel so browser(s) always see the live truth.
 */
export class Session {
  readonly id: string;
  spec: TuiSpec;
  rev = 0;
  revisions: Revision[] = [];
  /** user messages awaiting pickup by an agent (via wait_for_feedback) */
  pendingMessages: UserMessage[] = [];
  /** bounded thread digest — feeds export_bundle's notes.md */
  threadHistory: Array<{ who: "user" | "agent"; kind?: string; text: string; at: string }> = [];

  /** set by the server: broadcast a ServerMessage to all browsers */
  onEmit: (msg: ServerMessage) => void = () => {};

  /** blocked wait_for_feedback consumers, FIFO — longest-waiting first */
  private waiters: Waiter[] = [];

  constructor(id: string) {
    this.id = id;
    this.spec = structuredClone(SAMPLE_SPEC);
    this.revisions.push({
      rev: 0,
      at: new Date().toISOString(),
      note: "initial sample",
      spec: structuredClone(this.spec), // never alias the live spec (L9)
    });
  }

  /** Persisted session state (M9-lite): spec + rev + revision notes + thread. */
  serialize(): {
    savedAt: string;
    rev: number;
    spec: TuiSpec;
    revisionNotes: Array<{ rev: number; at: string; note: string }>;
    threadHistory: Array<{ who: "user" | "agent"; kind?: string; text: string; at: string }>;
  } {
    return {
      savedAt: new Date().toISOString(),
      rev: this.rev,
      spec: structuredClone(this.spec),
      revisionNotes: this.revisions.map(({ rev, at, note }) => ({ rev, at, note })),
      threadHistory: structuredClone(this.threadHistory),
    };
  }

  /** Restore from a persisted state (no re-validation needed: it was validated when written). */
  restore(state: {
    rev?: number;
    spec?: TuiSpec;
    revisionNotes?: Array<{ rev: number; at: string; note: string }>;
    threadHistory?: Array<{ who: "user" | "agent"; kind?: string; text: string; at: string }>;
  }): void {
    if (state.spec?.version === 1 && state.spec.root) {
      this.spec = structuredClone(state.spec);
      this.rev = typeof state.rev === "number" ? state.rev : 0;
      this.revisions = (state.revisionNotes ?? [{ rev: 0, at: new Date().toISOString(), note: "restored" }])
        .filter((n) => n.rev <= this.rev)
        .map((n) => (n.rev === this.rev ? { ...n, spec: structuredClone(this.spec) } : n));
      if (!this.revisions.some((r) => r.rev === this.rev)) {
        this.revisions.push({ rev: this.rev, at: new Date().toISOString(), note: "restored", spec: structuredClone(this.spec) });
      }
      this.threadHistory = Array.isArray(state.threadHistory) ? state.threadHistory.slice(-200) : [];
    }
  }

  /**
   * User sent a composed message from the inbox.
   * Validates and whitelists shape/size at the boundary (M6/H5) — anything
   * arriving here is trusted enough to inject into an agent's context.
   */
  handleUserMessage(raw: unknown): UserMessage {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("invalid user_message: body must be an object");
    }
    const { selection, regions, text } = raw as Record<string, unknown>;
    if (typeof text !== "string") {
      throw new Error("invalid user_message: text must be a string");
    }
    if (text.length > MAX_MESSAGE_TEXT) {
      throw new Error(`invalid user_message: text too long (max ${MAX_MESSAGE_TEXT} chars)`);
    }
    if (!Array.isArray(selection) || selection.length > MAX_SELECTION) {
      throw new Error(`invalid user_message: selection must be an array of at most ${MAX_SELECTION} entries`);
    }
    // R2-M4: bound the queue — an agent that never polls must not buffer forever
    if (this.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error(
        `feedback queue full (${MAX_PENDING_MESSAGES}) — the agent is not calling wait_for_feedback; try again later`,
      );
    }
    let regionList: CellRect[] | undefined;
    if (regions !== undefined) {
      if (!Array.isArray(regions) || regions.length > MAX_REGIONS) {
        throw new Error(`invalid user_message: regions must be an array of at most ${MAX_REGIONS} rects`);
      }
      regionList = regions.map((r) => parseRect(r)).filter((r): r is CellRect => r !== null);
    }

    const at = new Date().toISOString();
    const cleanSelection: SelectionRef[] = [];
    for (const s of selection) {
      if (typeof s !== "object" || s === null) continue;
      const e = s as Record<string, unknown>;
      if (typeof e.elementId !== "string" || e.elementId.length === 0) continue;
      const rect = parseRect(e.rect);
      if (!rect) continue;
      cleanSelection.push({
        elementId: e.elementId.slice(0, 120),
        kind: (typeof e.kind === "string" && KINDS.has(e.kind) ? e.kind : "panel") as NodeKind,
        title: typeof e.title === "string" ? e.title.slice(0, 200) : undefined,
        text: typeof e.text === "string" ? e.text.slice(0, 200) : undefined,
        annotation: typeof e.annotation === "string" ? e.annotation.slice(0, 2000) : undefined,
        rect,
        at,
      });
    }

    const message: UserMessage = {
      id: randomUUID(),
      selection: cleanSelection,
      regions: regionList,
      text,
      at,
    };
    this.pendingMessages.push(message);
    this.threadHistory.push({ who: "user", text: message.text, at: message.at });
    if (this.threadHistory.length > 200) this.threadHistory.splice(0, this.threadHistory.length - 200);
    const sel = message.selection.map((s) => s.elementId).slice(0, 5).join(",");
    console.log(`[user] selection=[${sel}] text="${message.text.slice(0, 80)}"`);
    this.onEmit({ type: "user_message_echo", message });
    this.notifyWaiters();
    return message;
  }

  /** Agent sent a message to the thread (via the MCP send_message tool). */
  addAgentMessage(text: string, kind: AgentMessageKind): AgentMessage {
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("message text must be a non-empty string");
    }
    if (text.length > MAX_SEND_MESSAGE) {
      throw new Error(`message too long (max ${MAX_SEND_MESSAGE} chars)`);
    }
    const message: AgentMessage = {
      id: randomUUID(),
      kind,
      text,
      at: new Date().toISOString(),
    };
    console.log(`[agent:${kind}] "${text.slice(0, 80)}"`);
    this.threadHistory.push({ who: "agent", kind, text, at: message.at });
    if (this.threadHistory.length > 200) this.threadHistory.splice(0, this.threadHistory.length - 200);
    this.onEmit({ type: "agent_message", message });
    return message;
  }

  private drain(): UserMessage[] {
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    return messages;
  }

  /** Deliver the whole pending batch to exactly one waiter (FIFO fairness). */
  private notifyWaiters(): void {
    if (this.pendingMessages.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.deliver(this.drain());
    // with no waiters, messages accumulate — nothing is ever lost
  }

  /**
   * Long-poll: resolves as soon as the user SENDS a composed message
   * (clicks while composing do not wake it), or after timeoutMs.
   * (H1) One waiter receives the entire batch — concurrent waiters can no
   * longer race or steal feedback, and a waiter that times out simply
   * leaves the queue without draining anything.
   * (R2-H1) `signal` catches well-behaved client cancellation
   * (notifications/cancelled, transport close); `liveness` catches raw
   * connection death — the SDK never aborts on that, so waiters poll it
   * and leave the queue (without draining) when the agent is unreachable.
   */
  async waitForFeedback(
    timeoutMs: number,
    signal?: AbortSignal,
    liveness?: () => boolean,
  ): Promise<{ messages: UserMessage[]; timedOut: boolean }> {
    if (this.pendingMessages.length > 0) {
      return { messages: this.drain(), timedOut: false };
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      const settle = (result: { messages: UserMessage[]; timedOut: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve(result);
      };
      const waiter: Waiter = {
        deliver: (messages) => settle({ messages, timedOut: false }),
        cancel: () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          settle({ messages: [], timedOut: true });
        },
      };
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        settle({ messages: [], timedOut: true });
      }, timeoutMs);
      timer.unref(); // R2-L7: a blocked waiter must not hold the event loop open
      if (liveness) {
        poll = setInterval(() => {
          if (!liveness()) waiter.cancel();
        }, 2_000);
        poll.unref();
      }
      if (signal) {
        if (signal.aborted) {
          waiter.cancel();
          return;
        }
        signal.addEventListener("abort", () => waiter.cancel(), { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * THE single mutation path for every agent-driven change (H3/M10):
   * baseRev check → apply ops or take full spec → validateSpec →
   * revision + live push. HTTP load and every MCP tool go through here.
   */
  applyAgentUpdate(input: AgentUpdateInput): AgentUpdateResult {
    if (input.baseRev !== undefined && input.baseRev !== this.rev) {
      return {
        ok: false,
        error:
          `stale base: you read rev ${input.baseRev} but the canvas is at rev ${this.rev}. ` +
          `Call get_design again and re-apply your change on top of the current spec.`,
      };
    }

    let candidate: TuiSpec;
    if (input.ops !== undefined) {
      const result = applyPatchOps(this.spec, input.ops);
      if (!result.ok || !result.spec) {
        return { ok: false, error: result.error };
      }
      candidate = result.spec;
    } else if (input.spec !== undefined) {
      candidate = input.spec as TuiSpec;
    } else {
      return { ok: false, error: "provide ops or spec" };
    }

    const validation = validateSpec(candidate);
    if (validation.errors.length > 0) {
      return {
        ok: false,
        error: `rejected — fix these and retry:\n` + validation.errors.map((e) => `- ${e}`).join("\n"),
      };
    }

    this.spec = candidate;
    this.rev += 1;
    const note = (input.note ?? "agent edit").slice(0, MAX_NOTE); // R2-L9
    this.revisions.push({
      rev: this.rev,
      at: new Date().toISOString(),
      note,
      spec: structuredClone(candidate),
    });
    if (this.revisions.length > MAX_REVISIONS) {
      this.revisions.splice(0, this.revisions.length - MAX_REVISIONS); // M2: ring buffer
    }
    this.onEmit({ type: "spec", spec: this.spec, rev: this.rev });
    this.onEmit({
      type: "system",
      text: `rev ${this.rev} applied — ${note}`,
      at: new Date().toISOString(),
    });
    console.log(`[spec] rev ${this.rev} applied — ${note}`);
    return { ok: true, rev: this.rev, warnings: validation.warnings };
  }

  /** Entry point for raw browser messages. Throws on invalid frames. */
  handleClientMessage(msg: ClientMessage): void {
    if (msg.type === "user_message") {
      this.handleUserMessage(msg.message);
    }
  }
}
