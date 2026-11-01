// src/shared/themes.ts
var THEMES = {
  tokyonight: {
    label: "Tokyo Night",
    colors: { bg: "#24283b", fg: "#c0caf5", border: "#414868", accent: "#7aa2f7", dim: "#565f89", selection: "#e0af68" }
  },
  catppuccin: {
    label: "Catppuccin Mocha",
    colors: { bg: "#1e1e2e", fg: "#cdd6f4", border: "#585b70", accent: "#89b4fa", dim: "#7f849c", selection: "#f9e2af" }
  },
  nord: {
    label: "Nord",
    colors: { bg: "#2e3440", fg: "#d8dee9", border: "#4c566a", accent: "#88c0d0", dim: "#69788f", selection: "#ebcb8b" }
  },
  gruvbox: {
    label: "Gruvbox Dark",
    colors: { bg: "#282828", fg: "#ebdbb2", border: "#504945", accent: "#83a598", dim: "#928374", selection: "#fabd2f" }
  },
  dracula: {
    label: "Dracula",
    colors: { bg: "#282a36", fg: "#f8f8f2", border: "#44475a", accent: "#bd93f9", dim: "#6272a4", selection: "#f1fa8c" }
  }
};
function themeByName(name) {
  return THEMES[name ?? ""] ?? THEMES.tokyonight;
}

// src/client/main.ts
var TOKEN = new URLSearchParams(location.search).get("token") ?? sessionStorage.getItem("tui-token") ?? "";
if (TOKEN) {
  try {
    sessionStorage.setItem("tui-token", TOKEN);
    if (new URLSearchParams(location.search).get("token")) {
      history.replaceState({}, "", "/");
    }
  } catch {
  }
}
var CELL = measureCell();
document.fonts?.ready.then(() => {
  const fresh = measureCell();
  if (Math.abs(fresh.w - CELL.w) > 0.01 || Math.abs(fresh.h - CELL.h) > 0.01) {
    CELL.w = fresh.w;
    CELL.h = fresh.h;
    if (currentSpec) render(currentSpec);
  }
});
function measureCell() {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(10);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:16px/1 'JetBrains Mono','Fira Code',Menlo,monospace;";
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return { w, h };
}
function px(n) {
  return Math.round(n * 100) / 100;
}
function rectStyle(r) {
  return {
    left: `${px(r.x * CELL.w)}px`,
    top: `${px(r.y * CELL.h)}px`,
    width: `${px(r.w * CELL.w)}px`,
    height: `${px(r.h * CELL.h)}px`
  };
}
var termEl = document.getElementById("term");
function styleOf(node) {
  const s = node.style ?? {};
  const out = {};
  if (s.fg) out.color = s.fg;
  if (s.bg) out.background = s.bg;
  if (s.bold) out.fontWeight = "700";
  if (s.dim) out.opacity = "0.6";
  return out;
}
function renderNode(node) {
  const el = document.createElement("div");
  el.className = `node node-${node.kind}`;
  el.dataset.id = node.id;
  Object.assign(el.style, rectStyle(node.rect), styleOf(node));
  if (node.annotation) {
    el.dataset.hasAnnotation = "1";
    el.title = node.annotation;
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
      value.textContent = node.focused ? "\u258F" : "";
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
function render(spec) {
  applyTheme(spec);
  termEl.classList.toggle("unicode-borders", spec.boxDrawing === true);
  termEl.style.width = `${px(spec.term.cols * CELL.w)}px`;
  termEl.style.height = `${px(spec.term.rows * CELL.h)}px`;
  termEl.replaceChildren(renderNode(spec.root));
  for (const id of [...selected]) {
    if (!currentSpec || !findNode(currentSpec.root, id)) {
      selected.delete(id);
    }
  }
  syncSelection();
}
function applyTheme(spec) {
  const t = themeByName(spec.theme).colors;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--term-bg", t.bg);
  rootStyle.setProperty("--fg", t.fg);
  rootStyle.setProperty("--accent", t.accent);
  rootStyle.setProperty("--dim", t.dim);
  rootStyle.setProperty("--border", t.border);
  rootStyle.setProperty("--select", t.selection);
}
var selected = /* @__PURE__ */ new Set();
var regions = [];
var dragEl = document.createElement("div");
dragEl.className = "region-drag";
dragEl.style.display = "none";
termEl.appendChild(dragEl);
function findNode(root, id) {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}
function syncSelection() {
  const ids = [...selected];
  for (const el of termEl.querySelectorAll(".node")) {
    const id = el.dataset.id;
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
function cssRect(r) {
  return `left:${px(r.x * CELL.w)}px;top:${px(r.y * CELL.h)}px;width:${px(r.w * CELL.w)}px;height:${px(r.h * CELL.h)}px`;
}
function renderChips() {
  const chips = document.getElementById("chips");
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
    x.textContent = "\xD7";
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
    label.textContent = `${r.w}\xD7${r.h} @${r.x},${r.y}`;
    chip.append(num, label);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "\xD7";
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
  const target = ev.target.closest(".node");
  if (!target || target.dataset.id === "root") {
    clearSelection();
    return;
  }
  const id = target.dataset.id;
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
var dragStart = null;
var lastDragRect = null;
function cellFromEvent(ev) {
  const frame = termEl.getBoundingClientRect();
  return {
    cx: Math.max(0, Math.floor((ev.clientX - frame.left) / CELL.w)),
    cy: Math.max(0, Math.floor((ev.clientY - frame.top) / CELL.h))
  };
}
termEl.addEventListener("mousedown", (ev) => {
  if (!currentSpec || ev.target.closest(".node")) return;
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
    h: Math.abs(cy - dragStart.cy) + 1
  };
  dragEl.style.display = "block";
  dragEl.style.cssText = `${cssRect(lastDragRect)};display:block`;
  dragEl.dataset.label = `${lastDragRect.w}\xD7${lastDragRect.h}`;
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
function buildSelectionRefs() {
  const at = (/* @__PURE__ */ new Date()).toISOString();
  return [...selected].flatMap((id) => {
    const node = currentSpec ? findNode(currentSpec.root, id) : null;
    if (!node) return [];
    return [{
      elementId: id,
      kind: node.kind,
      title: node.title,
      text: (node.content ?? "").slice(0, 80) || void 0,
      rect: node.rect,
      annotation: node.annotation,
      at
    }];
  });
}
function send() {
  const input = document.getElementById("composer-input");
  const text = input.value.trim();
  const selection = buildSelectionRefs();
  const hasRegions = regions.length > 0;
  if (!text && selection.length === 0 && !hasRegions) return;
  wsSend({
    type: "user_message",
    message: { selection, regions: hasRegions ? [...regions] : void 0, text }
  });
  input.value = "";
  clearSelection();
}
document.getElementById("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  send();
});
document.getElementById("composer-input").addEventListener("keydown", (ev) => {
  const e = ev;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById("clear-selection").addEventListener("click", clearSelection);
var threadEl = document.getElementById("thread");
function addThreadEl(el) {
  const stick = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
  threadEl.appendChild(el);
  if (stick) threadEl.scrollTop = threadEl.scrollHeight;
}
function timeOf(iso) {
  return new Date(iso).toLocaleTimeString();
}
function detailList(msg) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const bits = [];
  if (msg.selection.length) bits.push(`${msg.selection.length} element${msg.selection.length === 1 ? "" : "s"}`);
  if (msg.regions?.length) bits.push(`${msg.regions.length} region${msg.regions.length === 1 ? "" : "s"}`);
  summary.textContent = bits.join(" + ") || "context";
  details.appendChild(summary);
  const ul = document.createElement("ul");
  for (const ref of msg.selection) {
    const li = document.createElement("li");
    const what = ref.title?.trim() || ref.text?.trim() || ref.kind;
    li.textContent = `${ref.elementId} (${ref.kind}) \u2014 ${what} @ ${ref.rect.x},${ref.rect.y} ${ref.rect.w}x${ref.rect.h}${ref.annotation ? ` \u2605 "${ref.annotation}"` : ""}`;
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
function renderUserMessage(msg) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  const head = document.createElement("div");
  head.className = "msg-head";
  head.textContent = `you \xB7 ${timeOf(msg.at)}`;
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
function renderAgentMessage(msg) {
  const div = document.createElement("div");
  div.className = `msg msg-agent msg-${msg.kind}`;
  const head = document.createElement("div");
  head.className = "msg-head";
  head.textContent = `agent \xB7 ${msg.kind} \xB7 ${timeOf(msg.at)}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = msg.text;
  div.append(head, body);
  addThreadEl(div);
}
function renderSystem(text, at) {
  const div = document.createElement("div");
  div.className = "msg msg-system";
  div.textContent = `${text} \xB7 ${timeOf(at)}`;
  addThreadEl(div);
}
var currentSpec = null;
var wsProtocol = location.protocol === "https:" ? "wss" : "ws";
var ws;
var reconnectDelay = 1e3;
var reconnects = 0;
function wsSend(msg) {
  if (ws.readyState !== WebSocket.OPEN) {
    renderSystem("not connected \u2014 message not sent (reconnecting\u2026)", (/* @__PURE__ */ new Date()).toISOString());
    return;
  }
  ws.send(JSON.stringify(msg));
}
function connect() {
  const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
  ws = new WebSocket(`${wsProtocol}://${location.host}${qs}`);
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      console.error("unparseable frame from server");
      return;
    }
    switch (msg.type) {
      case "spec":
        currentSpec = msg.spec;
        render(msg.spec);
        document.getElementById("rev-label").textContent = `rev ${msg.rev}`;
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
        renderSystem(`error: ${msg.message}`, (/* @__PURE__ */ new Date()).toISOString());
        console.error("[server]", msg.message);
        break;
    }
  });
  ws.addEventListener("open", () => {
    console.log("connected to design server");
    if (reconnects > 0) {
      renderSystem(
        "reconnected \u2014 messages sent while offline may be missing from this thread",
        (/* @__PURE__ */ new Date()).toISOString()
      );
      reconnects = 0;
    }
    reconnectDelay = 1e3;
  });
  ws.addEventListener("close", () => {
    console.log(`disconnected \u2014 retrying in ${reconnectDelay}ms`);
    reconnects++;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15e3);
  });
}
if (TOKEN) connect();
else {
  renderSystem(
    "missing token: open this page with ?token=<token> (see server log)",
    (/* @__PURE__ */ new Date()).toISOString()
  );
}
//# sourceMappingURL=app.js.map
