import type { TuiSpec } from "./spec";

/**
 * Sample mock: an agent-harness-like TUI so there's something real to
 * click on from the very first run.
 */
export const SAMPLE_SPEC: TuiSpec = {
  version: 1,
  term: { cols: 80, rows: 24 },
  root: {
    id: "root",
    kind: "root",
    rect: { x: 0, y: 0, w: 80, h: 24 },
    children: [
      {
        id: "header",
        kind: "panel",
        rect: { x: 0, y: 0, w: 80, h: 1 },
        title: "",
        style: { bg: "#1e66f5", fg: "#eff1f5", bold: true },
        children: [
          {
            id: "header-title",
            kind: "text",
            rect: { x: 1, y: 0, w: 30, h: 1 },
            content: " agent-harness v0.1",
            style: { bold: true },
          },
          {
            id: "header-status",
            kind: "text",
            rect: { x: 62, y: 0, w: 17, h: 1 },
            content: "connected ● running",
            style: { fg: "#a6e3a1" },
          },
        ],
      },
      {
        id: "sidebar",
        kind: "panel",
        rect: { x: 0, y: 1, w: 22, h: 22 },
        title: " Sessions ",
        children: [
          {
            id: "session-active",
            kind: "text",
            rect: { x: 1, y: 2, w: 20, h: 1 },
            content: "▸ fix-websocket-race",
            style: { bold: true, fg: "#1e66f5" },
          },
          {
            id: "session-2",
            kind: "text",
            rect: { x: 1, y: 3, w: 20, h: 1 },
            content: "  refactor-schema",
          },
          {
            id: "session-3",
            kind: "text",
            rect: { x: 1, y: 4, w: 20, h: 1 },
            content: "  benchmark-logs",
          },
          {
            id: "btn-new-session",
            kind: "button",
            rect: { x: 1, y: 20, w: 20, h: 1 },
            title: "[ new session ]",
          },
        ],
      },
      {
        id: "main",
        kind: "panel",
        rect: { x: 22, y: 1, w: 58, h: 22 },
        title: " Run: fix-websocket-race ",
        children: [
          {
            id: "run-grid",
            kind: "grid",
            rect: { x: 23, y: 3, w: 56, h: 8 },
            data: {
              columns: ["step", "status", "duration", "tokens"],
              rows: [
                ["plan", "done", "2.1s", "1,204"],
                ["edit spec.ts", "done", "4.8s", "3,911"],
                ["run tests", "running", "12.3s", "8,450"],
                ["review diff", "pending", "-", "-"],
              ],
            },
          },
          {
            id: "log-panel",
            kind: "panel",
            rect: { x: 23, y: 13, w: 56, h: 7 },
            title: " log ",
            children: [
              {
                id: "log-text",
                kind: "text",
                rect: { x: 24, y: 14, w: 54, h: 5 },
                content:
                  " 12:03:11 ✓ tests 41/41 passed\n 12:03:12 → spawning reviewer agent…\n 12:03:14 ! flaky: ws-reconnect.test.ts (retry 1/2)",
              },
            ],
          },
          {
            id: "btn-approve",
            kind: "button",
            rect: { x: 23, y: 21, w: 14, h: 1 },
            title: "[ approve ]",
          },
          {
            id: "btn-retry",
            kind: "button",
            rect: { x: 39, y: 21, w: 12, h: 1 },
            title: "[ retry ]",
          },
          {
            id: "input-command",
            kind: "input",
            rect: { x: 53, y: 21, w: 26, h: 1 },
            title: ">",
            focused: true,
          },
        ],
      },
      {
        id: "statusbar",
        kind: "statusbar",
        rect: { x: 0, y: 23, w: 80, h: 1 },
        content: " ^N new  ^R retry  ^Q quit",
        style: { bg: "#4c4f69", fg: "#eff1f5" },
      },
    ],
  },
};
