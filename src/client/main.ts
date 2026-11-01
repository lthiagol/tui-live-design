import type {
  AgentMessage,
  CellRect,
  ClientMessage,
  SelectionRef,
  ServerMessage,
  TuiNode,
  TuiSpec,
  UserMessage,
} from "../shared/spec.js";
import { themeByName } from "../shared/themes.js";

// ---------------------------------------------------------------- cell grid

// R2-M2: capture the token from the URL once, keep it in sessionStorage for
// reloads, and strip it from the address bar so it doesn't linger in history.
const TOKEN =
  new URLSearchParams(location.search).get("token") ??
  sessionStorage.getItem("tui-token") ??
  "";
if (TOKEN) {
  try {
    sessionStorage.setItem("tui-token", TOKEN);
    if (new URLSearchParams(location.search).get("token")) {
      history.replaceState({}, "", "/");
    }
  } catch {
    // storage unavailable — keep working without persistence
  }
}

const CELL = measureCell() as { w: number; h: number };

// L5: re-measure once webfonts finish loading (async font load skews the grid)
document.fonts?.ready.then(() => {
  const fresh = measureCell();
  if (Math.abs(fresh.w - CELL.w) > 0.01 || Math.abs(fresh.h - CELL.h) > 0.01) {
    CELL.w = fresh.w;
    CELL.h = fresh.h;
    if (currentSpec) render(currentSpec);
  }
});

function measureCell(): { w: number; h: number } {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(10);
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font:16px/1 'JetBrains Mono','Fira Code',Menlo,monospace;";
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return { w, h };
}

function px(n: number): number {
  return Math.round(n * 100) / 100;
}

function rectStyle(r: CellRect): Partial<CSSStyleDeclaration> {
  return {
    left: `${px(r.x * CELL.w)}px`,
    top: `${px(r.y * CELL.h)}px`,
    width: `${px(r.w * CELL.w)}px`,
    height: `${px(r.h * CELL.h)}px`,
  };
}

// ---------------------------------------------------------------- renderer

const termEl = document.getElementById("term") as HTMLElement;

function styleOf(node: TuiNode): Partial<CSSStyleDeclaration> {
  const s = node.style ?? {};
  const out: Partial<CSSStyleDeclaration> = {};
  if (s.fg) out.color = s.fg;
  if (s.bg) out.background = s.bg;
  if (s.bold) out.fontWeight = "700";
  if (s.dim) out.opacity = "0.6";
  return out;
}

function renderNode(node: TuiNode): HTMLElement {
  const el = document.createElement("div");
  el.className = `node node-${node.kind}`;
  el.dataset.id = node.id;
  Object.assign(el.style, rectStyle(node.rect), styleOf(node));
  if (node.annotation) {
    el.dataset.hasAnnotation = "1";
    el.title = node.annotation; // native hover tooltip
  }

  switch (node.kind) {
    case "panel": {
      if (node.title) {
        const t = document.createElement("span");
        t.className = "panel-title";
        t.textContent = node.title;
        el.appendChild(t);
      }
      break;
    }
    case "button":
      el.textContent = node.title ?? node.content ?? "";
      break;
    case "input": {
      const label = document.createElement("span");
      label.className = "input-label";
      label.textContent = node.title ?? ">";
      const value = document.createElement("span");
      value.className = "input-value";
      value.textContent = node.focused ? "▏" : "";
      el.append(label, value);
      break;
    }
    case "grid": {
      const table = document.createElement("table");
      const head = document.createElement("tr");
      for (const c of node.data?.columns ?? []) {
        const th = document.createElement("th");
        th.textContent = c;
        head.appendChild(th);
      }
      table.appendChild(head);
      for (const row of node.data?.rows ?? []) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          td.textContent = cell;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      el.appendChild(table);
      break;
    }
    case "statusbar":
      el.textContent = node.content ?? "";
      break;
    default:
      if (node.content) el.textContent = node.content;
  }

  if (node.customHtml) {
    // C2: arbitrary HTML must never run in this page's origin — sandboxed
    // iframe (no scripts, no same-origin), so hostile specs are inert images.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.srcdoc = node.customHtml;
    frame.className = "custom-frame";
    frame.style.cssText = "width:100%;height:100%;border:none;background:transparent";
    el.appendChild(frame);
  }

  for (const child of node.children ?? []) {
    el.appendChild(renderNode(child));
  }
  return el;
}

function render(spec: TuiSpec) {
  applyTheme(spec);
  termEl.classList.toggle("unicode-borders", spec.boxDrawing === true);
  termEl.style.width = `${px(spec.term.cols * CELL.w)}px`;
  termEl.style.height = `${px(spec.term.rows * CELL.h)}px`;
  termEl.replaceChildren(renderNode(spec.root));
  // spec may have changed under our selection — prune ids that no longer exist
  for (const id of [...selected]) {
    if (!currentSpec || !findNode(currentSpec.root, id)) {
      selected.delete(id);
    }
  }
  syncSelection();
}

/** Push theme preset colors into the CSS custom properties. */
function applyTheme(spec: TuiSpec) {
  const t = themeByName(spec.theme).colors;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--term-bg", t.bg);
  rootStyle.setProperty("--fg", t.fg);
  rootStyle.setProperty("--accent", t.accent);
  rootStyle.setProperty("--dim", t.dim);
  rootStyle.setProperty("--border", t.border);
  rootStyle.setProperty("--select", t.selection);
}

// ---------------------------------------------------------------- selection

/** multi-select, in pick order */
const selected = new Set<string>();
/** dragged regions, in draw order */
const regions: CellRect[] = [];

/** overlay div for the in-progress drag + committed regions */
const dragEl = document.createElement("div");
dragEl.className = "region-drag";
dragEl.style.display = "none";
termEl.appendChild(dragEl);

function findNode(root: TuiNode, id: string): TuiNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Reflect the selected set onto the canvas (badges) and composer (chips). */
function syncSelection() {
  const ids = [...selected];
  for (const el of termEl.querySelectorAll(".node")) {
    const id = (el as HTMLElement).dataset.id!;
    const idx = ids.indexOf(id);
    el.classList.toggle("selected", idx >= 0);
    if (idx >= 0) {
      el.setAttribute("data-sel", String(idx + 1));
    } else {
      el.removeAttribute("data-sel");
    }
  }
  syncRegionOverlays();
  renderChips();
}

/** committed region overlays on the canvas */
function syncRegionOverlays() {
  for (const el of termEl.querySelectorAll(".region-overlay")) el.remove();
  regions.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "region-overlay";
    el.style.cssText = `${cssRect(r)};`;
    el.dataset.region = String(i + 1);
    termEl.appendChild(el);
  });
}

function cssRect(r: CellRect): string {
  return `left:${px(r.x * CELL.w)}px;top:${px(r.y * CELL.h)}px;width:${px(r.w * CELL.w)}px;height:${px(r.h * CELL.h)}px`;
}

function renderChips() {
  const chips = document.getElementById("chips")!;
  chips.replaceChildren();
  const ids = [...selected];
  if (ids.length === 0 && regions.length === 0) {
    const hint = document.createElement("span");
    hint.className = "chips-hint";
    hint.textContent = "click elements, or drag on empty space for a region";
    chips.appendChild(hint);
    return;
  }
  ids.forEach((id, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const num = document.createElement("b");
    num.textContent = String(i + 1);
    const label = document.createElement("span");
    const node = currentSpec ? findNode(currentSpec.root, id) : null;
    label.textContent = node?.title?.trim() || id;
    chip.append(num, label);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "remove from selection";
    x.addEventListener("click", () => {
      selected.delete(id);
      syncSelection();
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  });
  regions.forEach((r, i) => {
    const chip = document.createElement("span");
    chip.className = "chip chip-region";
    const num = document.createElement("b");
    num.textContent = `R${i + 1}`;
    const label = document.createElement("span");
    label.textContent = `${r.w}×${r.h} @${r.x},${r.y}`;
    chip.append(num, label);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "remove region";
    x.addEventListener("click", () => {
      regions.splice(i, 1);
      syncSelection();
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  });
}

termEl.addEventListener("click", (ev) => {
  if (!currentSpec) return;
  const target = (ev.target as HTMLElement).closest<HTMLElement>(".node");
  if (!target || target.dataset.id === "root") {
    clearSelection();
    return;
  }
  const id = target.dataset.id!;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  syncSelection();
});

function clearSelection() {
  selected.clear();
  regions.length = 0;
  syncSelection();
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") clearSelection();
});

// region drag: mousedown on empty canvas space starts a cell-rect selection
let dragStart: { cx: number; cy: number } | null = null;
let lastDragRect: CellRect | null = null;

function cellFromEvent(ev: MouseEvent): { cx: number; cy: number } {
  const frame = termEl.getBoundingClientRect();
  return {
    cx: Math.max(0, Math.floor((ev.clientX - frame.left) / CELL.w)),
    cy: Math.max(0, Math.floor((ev.clientY - frame.top) / CELL.h)),
  };
}

termEl.addEventListener("mousedown", (ev) => {
  if (!currentSpec || (ev.target as HTMLElement).closest(".node")) return;
  dragStart = cellFromEvent(ev);
  ev.preventDefault();
});

termEl.addEventListener("mousemove", (ev) => {
  if (!dragStart) return;
  const { cx, cy } = cellFromEvent(ev);
  lastDragRect = {
    x: Math.min(dragStart.cx, cx),
    y: Math.min(dragStart.cy, cy),
    w: Math.abs(cx - dragStart.cx) + 1,
    h: Math.abs(cy - dragStart.cy) + 1,
  };
  dragEl.style.display = "block";
  dragEl.style.cssText = `${cssRect(lastDragRect)};display:block`;
  dragEl.dataset.label = `${lastDragRect.w}×${lastDragRect.h}`;
});

window.addEventListener("mouseup", () => {
  if (!dragStart) return;
  dragEl.style.display = "none";
  if (lastDragRect) {
    regions.push({ ...lastDragRect });
    syncSelection();
  }
  lastDragRect = null;
  dragStart = null;
});

// ---------------------------------------------------------------- composer

function buildSelectionRefs(): SelectionRef[] {
  const at = new Date().toISOString();
  return [...selected].flatMap((id) => {
    const node = currentSpec ? findNode(currentSpec.root, id) : null;
    if (!node) return [];
    return [{
      elementId: id,
      kind: node.kind,
      title: node.title,
      text: (node.content ?? "").slice(0, 80) || undefined,
      rect: node.rect,
      annotation: node.annotation,
      at,
    }];
  });
}

function send() {
  const input = document.getElementById("composer-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  const selection = buildSelectionRefs();
  const hasRegions = regions.length > 0;
  if (!text && selection.length === 0 && !hasRegions) return;
  wsSend({
    type: "user_message",
    message: { selection, regions: hasRegions ? [...regions] : undefined, text },
  });
  input.value = "";
  clearSelection();
}

document.getElementById("composer")!.addEventListener("submit", (ev) => {
  ev.preventDefault();
  send();
});

document.getElementById("composer-input")!.addEventListener("keydown", (ev) => {
  const e = ev as KeyboardEvent;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.getElementById("clear-selection")!.addEventListener("click", clearSelection);

// ---------------------------------------------------------------- thread

const threadEl = document.getElementById("thread") as HTMLElement;

function scrollThreadIfNearBottom() {
  const nearBottom =
    threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
  if (nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
}

function addThreadEl(el: HTMLElement) {
  const stick = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
  threadEl.appendChild(el);
  if (stick) threadEl.scrollTop = threadEl.scrollHeight;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function detailList(msg: UserMessage): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const bits: string[] = [];
  if (msg.selection.length) bits.push(`${msg.selection.length} element${msg.selection.length === 1 ? "" : "s"}`);
  if (msg.regions?.length) bits.push(`${msg.regions.length} region${msg.regions.length === 1 ? "" : "s"}`);
  summary.textContent = bits.join(" + ") || "context";
  details.appendChild(summary);
  const ul = document.createElement("ul");
  for (const ref of msg.selection) {
    const li = document.createElement("li");
    const what = ref.title?.trim() || ref.text?.trim() || ref.kind;
    li.textContent = `${ref.elementId} (${ref.kind}) — ${what} @ ${ref.rect.x},${ref.rect.y} ${ref.rect.w}x${ref.rect.h}${ref.annotation ? ` ★ "${ref.annotation}"` : ""}`;
    ul.appendChild(li);
  }
  for (const [i, r] of (msg.regions ?? []).entries()) {
    const li = document.createElement("li");
    li.textContent = `region R${i + 1} @ ${r.x},${r.y} ${r.w}x${r.h} (empty space)`;
    ul.appendChild(li);
  }
  details.appendChild(ul);
  return details;
}

function renderUserMessage(msg: UserMessage) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  const head = document.createElement("div");
  head.className = "msg-head";
  head.textContent = `you · ${timeOf(msg.at)}`;
  div.appendChild(head);
  if (msg.text) {
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = msg.text;
    div.appendChild(body);
  }
  if (msg.selection.length > 0) div.appendChild(detailList(msg));
  addThreadEl(div);
}

function renderAgentMessage(msg: AgentMessage) {
  const div = document.createElement("div");
  div.className = `msg msg-agent msg-${msg.kind}`;
  const head = document.createElement("div");
  head.className = "msg-head";
  head.textContent = `agent · ${msg.kind} · ${timeOf(msg.at)}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = msg.text;
  div.append(head, body);
  addThreadEl(div);
}

function renderSystem(text: string, at: string) {
  const div = document.createElement("div");
  div.className = "msg msg-system";
  div.textContent = `${text} · ${timeOf(at)}`;
  addThreadEl(div);
}

// ---------------------------------------------------------------- websocket

let currentSpec: TuiSpec | null = null;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
let ws: WebSocket;
let reconnectDelay = 1000;
let reconnects = 0;

function wsSend(msg: ClientMessage) {
  if (ws.readyState !== WebSocket.OPEN) {
    renderSystem("not connected — message not sent (reconnecting…)", new Date().toISOString());
    return;
  }
  ws.send(JSON.stringify(msg));
}

// M8: reconnect with backoff; the server resyncs us by sending the spec on open
function connect() {
  const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
  ws = new WebSocket(`${wsProtocol}://${location.host}${qs}`);

  ws.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      console.error("unparseable frame from server");
      return;
    }
    switch (msg.type) {
      case "spec":
        currentSpec = msg.spec;
        render(msg.spec);
        document.getElementById("rev-label")!.textContent = `rev ${msg.rev}`;
        break;
      case "user_message_echo":
        renderUserMessage(msg.message);
        break;
      case "agent_message":
        renderAgentMessage(msg.message);
        break;
      case "system":
        renderSystem(msg.text, msg.at);
        break;
      case "error":
        renderSystem(`error: ${msg.message}`, new Date().toISOString());
        console.error("[server]", msg.message);
        break;
    }
  });

  ws.addEventListener("open", () => {
    console.log("connected to design server");
    if (reconnects > 0) {
      // R2-L5: messages broadcast while offline are gone — say so honestly
      renderSystem(
        "reconnected — messages sent while offline may be missing from this thread",
        new Date().toISOString(),
      );
      reconnects = 0;
    }
    reconnectDelay = 1000;
  });

  ws.addEventListener("close", () => {
    console.log(`disconnected — retrying in ${reconnectDelay}ms`);
    reconnects++;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  });
}

if (TOKEN) connect();
else {
  renderSystem(
    "missing token: open this page with ?token=<token> (see server log)",
    new Date().toISOString(),
  );
}
