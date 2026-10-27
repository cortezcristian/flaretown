// Overview page (SPEC-ui section 4): counters, org chart (d3-org-chart), right panel.

import { OrgChart } from "d3-org-chart";
import { select } from "d3";

type Agent = {
  id: string;
  name: string;
  tier: "principal" | "lead" | "operator";
  parent_id: string | null;
  area: string;
  model: string;
  status: "working" | "idle";
  current_task: { identifier: string; title: string } | null;
  open_tasks: number;
};
type Overview = {
  counts: { agents: number; working: number; projects: number; projects_open: number; open_tasks: number; review: number };
  agents: Agent[];
};
type Event = { at: string; kind: string; identifier: string; title: string; actor: string | null; detail: string | null };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let data: Overview | null = null;
let selectedId: string | null = null;
let chart: any = null;
let lastShape = "";
let lastRender = "";

const MODEL_NAMES: Record<string, string> = {};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function nodeHtml(a: Agent) {
  const working = a.status === "working";
  return `
    <div class="node ${a.tier} ${working ? "working" : ""} ${a.id === selectedId ? "selected" : ""}">
      <div class="node-top">
        <div class="avatar">${esc(initials(a.name))}</div>
        <div class="node-who">
          <div class="node-name">${esc(a.name)}</div>
          <div class="node-tier">${esc(a.tier)}</div>
        </div>
        <button class="node-chat" data-chat="${esc(a.id)}" title="Open chat">Chat</button>
      </div>
      <div class="node-status"><span class="pulse"></span>${working ? "working" : "idle"}
        ${a.current_task ? `<span class="node-task">${esc(a.current_task.identifier)}</span>` : ""}</div>
      <div class="node-meta">${a.open_tasks} open task${a.open_tasks === 1 ? "" : "s"}</div>
    </div>`;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderChart() {
  if (!data) return;
  const nodes = data.agents.map((a) => ({ ...a, parentId: a.parent_id ?? "" }));
  // Only rebuild the layout when the tree shape changes; otherwise just refresh the nodes.
  const shape = nodes.map((n) => `${n.id}:${n.parentId}`).join("|");

  if (!chart) {
    chart = new OrgChart()
      .container("#chart")
      .svgHeight(Math.max(420, window.innerHeight - 320))
      .nodeId((d: any) => d.id)
      .parentNodeId((d: any) => d.parentId || null)
      .nodeWidth(() => 230)
      .nodeHeight(() => 112)
      .childrenMargin(() => 56)
      .siblingsMargin(() => 24)
      .compact(false)
      .nodeContent((d: any) => nodeHtml(d.data as Agent))
      .linkUpdate(function (this: SVGPathElement) {
        select(this).attr("stroke", cssVar("--border")).attr("stroke-width", 1.5);
      })
      .onNodeClick((arg: any) => {
        const id = typeof arg === "string" ? arg : (arg?.data?.id ?? arg?.id);
        if (id) selectAgent(id);
      });
  }

  // Skip re-rendering when nothing visible changed (polling every 5 s shouldn't reset the view).
  const snapshot = JSON.stringify([nodes, selectedId]);
  if (snapshot === lastRender) return;
  lastRender = snapshot;

  chart.data(nodes);
  chart.render();
  if (shape !== lastShape) {
    chart.expandAll().fit();
    lastShape = shape;
  }
}

function renderCounters() {
  if (!data) return;
  const c = data.counts;
  $("c-agents").textContent = String(c.agents);
  $("c-working").textContent = c.working ? `${c.working} working` : "all idle";
  $("c-projects").textContent = String(c.projects);
  $("c-projects-sub").textContent = c.projects_open ? `${c.projects_open} with open tasks` : "no open tasks";
  $("c-open").textContent = String(c.open_tasks);
  $("c-review").textContent = String(c.review);
}

// ---- right panel ----------------------------------------------------------------------------

const PANEL_KEY = "flaretown.overview.panel";

function setPanelOpen(open: boolean) {
  $("panel").hidden = !open;
  $("toggle-panel").classList.toggle("active", open);
  try {
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  } catch {
    /* storage may be unavailable */
  }
}

function panelOpenByDefault() {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

function describe(e: Event) {
  const who = e.actor ? esc(e.actor.replace(/^agent:/, "")) : "";
  const task = `<span class="id">${esc(e.identifier)}</span> ${esc(e.title)}`;
  switch (e.kind) {
    case "task_created":
      return `${task} created${who ? ` by ${who}` : ""}`;
    case "task_done":
      return `${task} closed`;
    case "task_cancelled":
      return `${task} cancelled`;
    case "comment":
      return `${who} commented on ${task}<div class="meta">${esc(e.detail)}</div>`;
    case "report":
      return `${who} saved report “${esc(e.detail)}” on ${task}`;
    default:
      return task;
  }
}

async function showActivity() {
  $("panel-title").textContent = "Recent activity";
  try {
    const { events } = (await (await fetch("/api/activity?limit=20")).json()) as { events: Event[] };
    if (selectedId) return; // user picked an agent meanwhile
    $("panel-body").innerHTML = events.length
      ? events
          .map((e) => `<div class="comment"><div class="meta">${new Date(e.at).toLocaleString()}</div>${describe(e)}</div>`)
          .join("")
      : `<div class="meta">Nothing yet.</div>`;
  } catch {
    $("panel-body").innerHTML = `<div class="error">Couldn't load activity.</div>`;
  }
}

function showAgent(a: Agent) {
  const parent = data?.agents.find((x) => x.id === a.parent_id);
  $("panel-title").textContent = a.name;
  $("panel-body").innerHTML = `
    <div class="meta">${esc(a.tier)} · ${esc(a.id)}</div>
    <label>Status</label><div>${a.status === "working" ? "Working" : "Idle"}</div>
    <label>Reports to</label><div>${parent ? esc(parent.name) : "Human"}</div>
    ${a.area ? `<label>Area</label><div>${esc(a.area)}</div>` : ""}
    <label>Model</label><div>${esc(MODEL_NAMES[a.model] ?? a.model)}</div>
    <label>Current task</label><div>${a.current_task ? `<span class="id">${esc(a.current_task.identifier)}</span> ${esc(a.current_task.title)}` : "None"}</div>
    <label>Open tasks</label><div>${a.open_tasks}</div>
    <div class="form-actions">
      <a class="primary" href="/chat.html?agent=${encodeURIComponent(a.id)}">Open chat</a>
      <a class="ghost" href="/agents.html">Agents</a>
      <button class="ghost" id="clear-selection">Back to activity</button>
    </div>`;
  $("clear-selection").addEventListener("click", () => {
    selectedId = null;
    renderChart();
    void showActivity();
  });
}

function selectAgent(id: string) {
  const a = data?.agents.find((x) => x.id === id);
  if (!a) return;
  selectedId = id;
  setPanelOpen(true);
  showAgent(a);
  renderChart();
}

// ---- data -----------------------------------------------------------------------------------

async function load() {
  const res = await fetch("/api/overview");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = (await res.json()) as Overview;
  renderCounters();
  renderChart();
  if (selectedId) {
    const a = data.agents.find((x) => x.id === selectedId);
    if (a) showAgent(a);
  }
}

async function loadHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    $("health").innerHTML = `API <b class="${h.ok ? "ok" : "bad"}">${h.ok ? "ok" : "degraded"}</b> · DB core <b class="${h.databases?.core ? "ok" : "bad"}">${h.databases?.core ? "ok" : "down"}</b> · DB runs <b class="${h.databases?.runs ? "ok" : "bad"}">${h.databases?.runs ? "ok" : "down"}</b> · <code>${esc(h.version ?? "local")}</code>`;
  } catch {
    $("health").textContent = "API unreachable";
  }
}

async function main() {
  // Chat buttons inside nodes.
  $("chart").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-chat]") as HTMLElement | null;
    if (btn) {
      e.stopPropagation();
      location.href = `/chat.html?agent=${encodeURIComponent(btn.dataset.chat!)}`;
    }
  }, true);
  $("chart").addEventListener("dblclick", (e) => {
    const node = (e.target as HTMLElement).closest(".node") as HTMLElement | null;
    const id = node?.querySelector("[data-chat]")?.getAttribute("data-chat");
    if (id) location.href = `/chat.html?agent=${encodeURIComponent(id)}`;
  });

  $("fit").addEventListener("click", () => chart?.fit());
  $("zoom-in").addEventListener("click", () => chart?.zoomIn());
  $("zoom-out").addEventListener("click", () => chart?.zoomOut());
  $("expand").addEventListener("click", () => chart?.expandAll().fit());
  $("collapse").addEventListener("click", () => chart?.collapseAll().fit());
  // Activity button: if an agent is showing, switch back to activity; otherwise open/close the panel.
  $("toggle-panel").addEventListener("click", () => {
    if (selectedId) {
      selectedId = null;
      renderChart();
      setPanelOpen(true);
      void showActivity();
      return;
    }
    const opening = $("panel").hidden;
    setPanelOpen(opening);
    if (opening) void showActivity();
  });
  $("close-panel").addEventListener("click", () => setPanelOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("panel").hidden) setPanelOpen(false);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderChart());
  window.addEventListener("ft-theme", () => renderChart()); // theme picked in Cmd+K

  try {
    const { models } = await (await fetch("/api/models")).json();
    for (const m of models as Array<{ id: string; name: string }>) MODEL_NAMES[m.id] = m.name;
  } catch {
    /* names are optional */
  }

  setPanelOpen(panelOpenByDefault());
  try {
    await load();
  } catch (err) {
    $("chart").innerHTML = `<div class="error" style="padding:16px">Couldn't load the overview: ${esc(err instanceof Error ? err.message : err)}</div>`;
  }
  void showActivity();
  void loadHealth();

  setInterval(() => {
    if (document.hidden) return;
    load().catch(() => {});
    if (!selectedId && !$("panel").hidden) void showActivity();
  }, 5000);
}

void main();
