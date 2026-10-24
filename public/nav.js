// Left navigation panel shared by every page (SPEC-ui section 3).
// Each page includes <script src="/nav.js" defer></script>; this injects the panel.
(() => {
  const ITEMS = [
    { href: "/", label: "Overview", icon: "M3 12l9-8 9 8M5 10v10h14V10" },
    { href: "/chat.html", label: "Chat", icon: "M4 5h16v11H8l-4 4z" },
    { href: "/tasks.html", label: "Tasks", icon: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2", badge: "tasks" },
    { href: "/kanban.html", label: "Kanban", icon: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z" },
    { href: "/routines.html", label: "Routines", icon: "M12 7v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" },
    { href: "/artifacts.html", label: "Artifacts", icon: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" },
    { href: "/containers.html", label: "Containers", icon: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10" },
    { href: "/agents.html", label: "Agents", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6" },
    { href: "/orchestrator.html", label: "Orchestrator", icon: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
  ];

  const style = document.createElement("style");
  style.textContent = `
    body.with-nav { padding-left: 220px; }
    .ft-nav { position: fixed; inset: 0 auto 0 0; width: 220px; display: flex; flex-direction: column; gap: 2px;
      padding: 16px 10px; background: var(--card); border-right: 1px solid var(--border); z-index: 10; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .ft-nav .top { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .ft-nav .collapse { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; padding: 0; margin-bottom: 12px; }
    .ft-nav .collapse:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); }
    .ft-nav .collapse svg { transition: transform .2s ease; }
    body.with-nav { transition: padding-left .2s ease; }
    .ft-nav { transition: width .2s ease; }
    body.with-nav.nav-collapsed { padding-left: 60px; }
    body.nav-collapsed .ft-nav { width: 60px; padding-left: 8px; padding-right: 8px; }
    body.nav-collapsed .ft-nav .label, body.nav-collapsed .ft-nav .group, body.nav-collapsed .ft-nav .keys { display: none; }
    body.nav-collapsed .ft-nav .top { flex-direction: column; }
    body.nav-collapsed .ft-nav .brand { padding: 4px 0 8px; justify-content: center; }
    body.nav-collapsed .ft-nav .collapse svg { transform: rotate(180deg); }
    body.nav-collapsed .ft-nav a.item, body.nav-collapsed .ft-nav .kbd { justify-content: center; padding: 8px 0; position: relative; }
    body.nav-collapsed .ft-nav .count { position: absolute; top: 2px; right: 4px; min-width: 16px; padding: 0 4px; font-size: 10px; }
    .ft-nav .brand { display: flex; align-items: center; gap: 8px; padding: 4px 10px 16px; font-weight: 700; font-size: 16px; color: var(--fg); text-decoration: none; }
    .ft-nav .brand span { color: var(--accent); }
    .ft-nav .group { padding: 10px 10px 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    .ft-nav a.item { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; color: var(--fg); text-decoration: none; }
    .ft-nav a.item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .ft-nav a.item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
    .ft-nav svg { width: 16px; height: 16px; flex: none; }
    .ft-nav .brand svg.logo { width: 24px; height: 24px; }
    /* Resizable right panel (any <aside>): drag its left edge; width remembered per browser. */
    aside.ft-resizable { position: relative; }
    @media (min-width: 801px) { aside.ft-resizable.ft-sized { width: var(--ft-panel-w) !important; } }
    /* Sticky so it stays on the panel's left edge while the panel scrolls; the panels have 16px padding. */
    .ft-resize { position: sticky; top: 0; height: 0; z-index: 5; }
    .ft-resize::before { content: ""; position: absolute; top: -16px; left: -16px; width: 8px; height: calc(100vh + 32px); cursor: col-resize; }
    .ft-resize::after { content: ""; position: absolute; top: -16px; left: -16px; width: 2px; height: calc(100vh + 32px); background: transparent; transition: background .15s; pointer-events: none; }
    .ft-resize:hover::after, body.ft-resizing .ft-resize::after { background: var(--accent); }
    body.ft-resizing { cursor: col-resize; user-select: none; }
    body.ft-resizing iframe { pointer-events: none; }
    @media (max-width: 800px) { .ft-resize { display: none; } }
    .ft-nav .count { margin-left: auto; min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; text-align: center; }
    .ft-nav .count:empty { display: none; }
    .ft-nav .kbd { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--muted); font: inherit; cursor: pointer; text-align: left; }
    .ft-nav .kbd:hover { color: var(--accent); border-color: var(--accent); }
    .ft-nav .kbd .keys { margin-left: auto; font-size: 11px; font-family: ui-monospace, monospace; }
    @media (max-width: 800px) {
      body.with-nav, body.with-nav.nav-collapsed { padding-left: 0; padding-top: 52px; }
      .ft-nav .collapse { display: none; }
      body.nav-collapsed .ft-nav { width: auto; }
      body.nav-collapsed .ft-nav .label { display: inline; }
      .ft-nav { inset: 0 0 auto 0; width: auto; height: 52px; flex-direction: row; align-items: center; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
      .ft-nav .brand { padding: 0 8px; }
      .ft-nav .group { display: none; }
    }`;
  document.head.appendChild(style);

  const path = location.pathname === "/index.html" ? "/" : location.pathname.replace(/\/$/, "") || "/";
  const isActive = (href) => href === path || href.replace(/\.html$/, "") === path;

  const nav = document.createElement("nav");
  nav.className = "ft-nav";
  nav.setAttribute("aria-label", "Main");
  nav.innerHTML = `
    <div class="top">
      <a class="brand" href="/"><svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#f6821f"/><path d="M7.5 18.5V7l5.5-2.5v14M13 18.5v-8.5l4 1.5v7M5.5 18.5h13" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.6 9h1.4M9.6 11.8h1.4M9.6 14.6h1.4M14.7 13.4h.8M14.7 16h.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg> <span class="label">Flaretown</span></a>
      <button class="collapse" type="button" aria-label="Collapse menu" title="Collapse menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
    </div>
    <div class="group">Workspace</div>
    ${ITEMS.map((i) => `
      <a class="item${isActive(i.href) ? " active" : ""}" href="${i.href}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${i.icon}"/></svg>
        <span class="label">${i.label}</span>
        ${i.badge ? `<span class="count" data-badge="${i.badge}"></span>` : ""}
      </a>`).join("")}`;
  document.body.prepend(nav);
  document.body.classList.add("with-nav");

  // Cmd+K palette (client/palette.tsx, bundled to /palette.js).
  const palette = document.createElement("script");
  palette.type = "module";
  palette.src = "/palette.js";
  document.head.appendChild(palette);

  const hint = document.createElement("button");
  hint.className = "item kbd";
  hint.type = "button";
  hint.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span class="label">Jump to</span> <span class="keys">⌘K</span>`;
  hint.addEventListener("click", () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })),
  );
  nav.appendChild(hint);

  // Collapse to icons only; remembered per browser.
  const COLLAPSE_KEY = "flaretown.nav.collapsed";
  const setCollapsed = (collapsed) => {
    document.body.classList.toggle("nav-collapsed", collapsed);
    const btn = nav.querySelector(".collapse");
    btn.setAttribute("aria-label", collapsed ? "Expand menu" : "Collapse menu");
    btn.title = collapsed ? "Expand menu" : "Collapse menu";
    nav.querySelectorAll("a.item").forEach((a) => (a.title = collapsed ? a.textContent.trim() : ""));
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* storage may be unavailable */ }
  };
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { /* default expanded */ }
  setCollapsed(startCollapsed);
  nav.querySelector(".collapse").addEventListener("click", () =>
    setCollapsed(!document.body.classList.contains("nav-collapsed")),
  );

  // Favicon: the same logo (orange rounded square with a building).
  if (!document.querySelector('link[rel="icon"]')) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/svg+xml";
    icon.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${nav.querySelector("svg.logo").outerHTML.slice(5)}`)}`;
    document.head.appendChild(icon);
  }

  // Resizable right panel. Every page's context panel is an <aside> (the chat adds and removes
  // its own), so watch for them. One width for all pages; double-click the edge to reset.
  const WIDTH_KEY = "flaretown.panel.width";
  const MIN_W = 260;
  const maxW = () => Math.max(MIN_W, Math.min(960, window.innerWidth - 420));
  const applyWidth = (w) => {
    if (w) {
      document.documentElement.style.setProperty("--ft-panel-w", `${w}px`);
      document.querySelectorAll("aside.ft-resizable").forEach((a) => a.classList.add("ft-sized"));
    } else {
      document.documentElement.style.removeProperty("--ft-panel-w");
      document.querySelectorAll("aside.ft-resizable").forEach((a) => a.classList.remove("ft-sized"));
    }
  };
  let savedW = 0;
  try { savedW = Number(localStorage.getItem(WIDTH_KEY)) || 0; } catch { /* no storage */ }
  const attachResize = (aside) => {
    if (aside.classList.contains("ft-resizable")) return;
    aside.classList.add("ft-resizable");
    if (savedW) aside.classList.add("ft-sized");
    const handle = document.createElement("div");
    handle.className = "ft-resize";
    handle.title = "Drag to resize, double-click to reset";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    aside.prepend(handle);
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("ft-resizing");
      const right = aside.getBoundingClientRect().right;
      const move = (ev) => {
        savedW = Math.round(Math.min(maxW(), Math.max(MIN_W, right - ev.clientX)));
        applyWidth(savedW);
      };
      const up = () => {
        document.body.classList.remove("ft-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try { localStorage.setItem(WIDTH_KEY, String(savedW)); } catch { /* not remembered */ }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      savedW = 0;
      applyWidth(0);
      try { localStorage.removeItem(WIDTH_KEY); } catch { /* ignore */ }
    });
  };
  applyWidth(savedW);
  document.querySelectorAll("aside").forEach(attachResize);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.tagName === "ASIDE") attachResize(n);
        n.querySelectorAll?.("aside").forEach(attachResize);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Badge: open tasks count.
  const refresh = () =>
    fetch("/api/tasks?filter=open")
      .then((r) => r.json())
      .then((d) => {
        const el = nav.querySelector('[data-badge="tasks"]');
        if (el) el.textContent = d.counts?.open ? String(d.counts.open) : "";
      })
      .catch(() => {});
  refresh();
  setInterval(refresh, 15000);
})();
