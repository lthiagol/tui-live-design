/**
 * TUI spec — the single source of truth.
 *
 * Everything lives in terminal CELL coordinates (cols/rows), not pixels.
 * The browser compiles this to HTML/CSS; element ids bridge DOM clicks
 * and spec nodes. Later, this same spec can compile to real TUI code
 * (Textual, ratatui, ...).
 */

export interface CellRect {
  /** column of the top-left corner (0-based) */
  x: number;
  /** row of the top-left corner (0-based) */
  y: number;
  /** width in cells (including borders) */
  w: number;
  /** height in cells (including borders) */
  h: number;
}

export type NodeKind =
  | "root"
  | "panel"
  | "text"
  | "button"
  | "input"
  | "grid"
  | "statusbar";

export interface TuiStyle {
  /** foreground color name or hex */
  fg?: string;
  /** background color name or hex */
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export type GridData = {
  columns: string[];
  rows: string[][];
};

export interface TuiNode {
  /** stable id — the bridge between DOM clicks and spec nodes */
  id: string;
  kind: NodeKind;
  rect: CellRect;
  /** panel/window title, button label, input placeholder, etc. */
  title?: string;
  /** text content (newlines respected for kind=text) */
  content?: string;
  /** rows/cols data for kind=grid */
  data?: GridData;
  /** focused flag for inputs */
  focused?: boolean;
  style?: TuiStyle;
  children?: TuiNode[];
  /** persistent note attached to this element (shows as a pin on the canvas) */
  annotation?: string;
  /**
   * Escape hatch: raw HTML/CSS rendered inside this node's rect.
   * Schema-first with a free-form door for one-off custom bits.
   */
  customHtml?: string;
}

export interface TuiSpec {
  version: 1;
  /** terminal dimensions in cells */
  term: { cols: number; rows: number };
  root: TuiNode;
  /** theme preset name (see shared/themes.ts); undefined = tokyonight */
  theme?: string;
  /** true = double-line CSS borders for a box-drawing look */
  boxDrawing?: boolean;
  /**
   * Runtime the REAL TUI will be implemented in — decided at the start of
   * every design project ("what are we building for?"), drives code export.
   * Known: ratatui | textual | bubbletea | blessed | ink | custom
   */
  target?: string;
}

/** One revision of the design, kept for the timeline/undo. */
export interface Revision {
  rev: number;
  at: string;
  note: string;
  spec: TuiSpec;
}

/** A picked element, as attached to a user message. */
export interface SelectionRef {
  elementId: string;
  kind: NodeKind;
  title?: string;
  /** visible text content, truncated */
  text?: string;
  /** cell rect within the terminal */
  rect: CellRect;
  /** persistent note on this element, if any */
  annotation?: string;
  at: string;
}

/** A user-drawn region on the canvas (no element exists there — yet). */
export type RegionRef = CellRect;

/** A composed user message: selection + regions + text, sent on Send. */
export interface UserMessage {
  id: string;
  selection: SelectionRef[];
  regions?: RegionRef[];
  text: string;
  at: string;
}

export type AgentMessageKind = "note" | "question" | "summary";

/** A message from the agent: explanations, questions, summaries. */
export interface AgentMessage {
  id: string;
  kind: AgentMessageKind;
  text: string;
  at: string;
}

/** Messages browser -> server */
export type ClientMessage = {
  type: "user_message";
  message: { selection: SelectionRef[]; regions?: RegionRef[]; text: string };
};

/** Messages server -> browser */
export type ServerMessage =
  | { type: "spec"; spec: TuiSpec; rev: number }
  | { type: "user_message_echo"; message: UserMessage }
  | { type: "agent_message"; message: AgentMessage }
  | { type: "system"; text: string; at: string }
  | { type: "error"; message: string };
