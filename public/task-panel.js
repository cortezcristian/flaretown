// Task panel shared by Tasks and Kanban (SPEC-sections-view 1.2, 1.3): New task form and task
// details in the right panel. Needs #panel, #panel-title, #panel-body, #close-panel on the page.
//   TaskPanel.init({ onChange, onSelect })   onChange: refresh the page's data after an action
//                                            onSelect(id | null): highlight the selected task
//   TaskPanel.openNewTask() / TaskPanel.openDetails(id) / TaskPanel.close()
(() => {
    const el = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    let opts = { onChange: async () => {}, onSelect: () => {} };

    // ---- panel ---------------------------------------------------------------------------
    function showPanel(title, html) {
      el("panel-title").textContent = title;
      el("panel-body").innerHTML = html;
      el("panel").hidden = false;
    }
    function closePanel() {
      el("panel").hidden = true;
      opts.onSelect(null);
    }
    el("close-panel").addEventListener("click", closePanel);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el("panel").hidden) closePanel(); });

    async function apiCall(method, url, body) {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      if (!res.ok) throw new Error(`${data.error}${data.hint ? ` (${data.hint})` : ""}`);
      return data;
    }

    // ---- new task form (SPEC-sections-view 1.2) -----------------------------------------
    async function openNewTask() {
      opts.onSelect(null);
      const [{ projects }, { agents }] = await Promise.all([
        (await fetch("/api/projects")).json(),
        (await fetch("/api/agents")).json(),
      ]);
      const leads = agents.filter((a) => a.tier === "lead");
      const assigneeOptions = [
        `<option value="principal">Principal</option>`,
        ...leads.map((l) => `<optgroup label="${esc(l.name)} (Lead)">
          <option value="${esc(l.id)}">${esc(l.name)}</option>
          ${agents.filter((a) => a.parent_id === l.id).map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (Operator)</option>`).join("")}
        </optgroup>`),
      ].join("");
      showPanel("New task", `
        <form id="new-form">
          <label for="f-text">Task</label>
          <textarea id="f-text" required style="min-height:200px" placeholder="Add a deploy badge to the README

Acceptance criteria:
- [ ] Badge visible at the top of the README
- [ ] Link opens the deploy page"></textarea>
          <div class="meta">First line is the title. Lines starting with <code>- [ ]</code> become acceptance criteria.</div>

          <label for="f-project">Project</label>
          <select id="f-project">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === "default" ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>

          <label for="f-assignee">Assign to</label>
          <select id="f-assignee">${assigneeOptions}</select>

          <label>Mode</label>
          <div class="segmented" id="f-mode">
            <button type="button" data-mode="queue" class="active">Queue</button>
            <button type="button" data-mode="run">Run now</button>
          </div>
          <div class="meta" id="f-mode-hint">Waits in the queue for the Orchestrator.</div>

          <label style="display:flex;align-items:center;gap:8px;color:var(--fg)"><input type="checkbox" id="f-approval" style="width:auto"> Requires approval</label>
          <div class="meta">The agent can't move it to review until a Decision on it is approved.</div>

          <div class="error" id="f-error"></div>
          <div class="form-actions">
            <button type="submit" class="primary" id="f-submit">Create task</button>
          </div>
        </form>`);

      el("f-text").focus();

      let mode = "queue";
      const hints = { queue: "Waits in the queue for the Orchestrator.", run: "The assigned agent starts working on it right away." };
      document.querySelectorAll("#f-mode button").forEach((b) =>
        b.addEventListener("click", () => {
          mode = b.dataset.mode;
          document.querySelectorAll("#f-mode button").forEach((x) => x.classList.toggle("active", x === b));
          el("f-mode-hint").textContent = hints[mode];
        }),
      );

      el("new-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = el("f-text").value;
        // "- [ ] ..." / "- [x] ..." lines are the acceptance criteria; they stay in the text too.
        const criteria = text.split("\n").map((l) => l.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/)?.[1]?.trim()).filter(Boolean);
        const submit = el("f-submit");
        if (submit.disabled) return;
        submit.disabled = true;
        submit.textContent = "Creating…";
        el("f-error").textContent = "";
        try {
          const task = await apiCall("POST", "/api/tasks", {
            description: text,
            criteria,
            project_id: el("f-project").value,
            assignee: el("f-assignee").value,
            requires_approval: el("f-approval").checked,
          });
          if (mode === "run") await apiCall("POST", `/api/tasks/${task.id}/run`);
          await opts.onChange();
          openDetails(task.id);
        } catch (err) {
          el("f-error").textContent = err.message;
          submit.disabled = false;
          submit.textContent = "Create task";
        }
      });
    }

    // ---- task details (SPEC-sections-view 1.3) ------------------------------------------
    async function openDetails(id) {
      opts.onSelect(id);
      const t = await (await fetch(`/api/tasks/${encodeURIComponent(id)}`)).json();
      const open = ["todo", "in_progress", "review"].includes(t.state);
      showPanel(`${t.identifier}`, `
        <div><strong>${esc(t.title)}</strong></div>
        <div class="meta">${esc(t.state.replace("_", " "))} · ${esc(t.assignee || "unassigned")} · project ${esc(t.project_id)}${t.requires_approval ? ` · <span class="state">requires approval</span>` : ""}</div>
        <p style="white-space: pre-wrap">${esc(t.description)}</p>

        <label>Acceptance criteria</label>
        ${t.criteria.length ? `<ul class="criteria-list">${t.criteria.map((c) => `
          <li><input type="checkbox" data-pos="${c.position}" ${c.checked ? "checked" : ""} ${open ? "" : "disabled"}>
          <span>${esc(c.text)}${c.checked_by ? ` <span class="meta">· ${esc(c.checked_by)}</span>` : ""}</span></li>`).join("")}</ul>`
          : `<div class="meta">None</div>`}

        ${open ? `<div class="form-actions">
          ${t.state === "todo" ? `<button class="primary" id="d-run">Run now</button>` : ""}
          ${t.state === "in_progress" && t.assignee ? `<a class="ghost" href="/chat.html?agent=${encodeURIComponent(t.assignee)}">Watch in chat →</a>` : ""}
          <button class="${t.state === "todo" ? "ghost" : "primary"}" id="d-close">Close</button>
          ${t.state === "review" ? `<button class="ghost" id="d-sendback">Send back</button>` : ""}
          <button class="ghost danger" id="d-cancel">Cancel task</button>
        </div>` : ""}
        <div class="error" id="d-error"></div>

        ${t.subtasks?.length ? `<label>Subtasks (${t.subtasks.filter((x) => x.state === "done").length}/${t.subtasks.length} done)</label>
          ${t.subtasks.map((x) => `<div class="comment"><a href="#" data-open="${esc(x.id)}"><span class="id">${esc(x.identifier)}</span> ${esc(x.title)}</a>
            <div class="meta">${esc(x.state.replace("_", " "))} · ${esc(x.assignee || "unassigned")} · criteria ${x.criteria_checked}/${x.criteria_total}</div></div>`).join("")}` : ""}
        ${t.parent_id ? `<label>Parent</label><div><a href="#" data-open="${esc(t.parent_id)}">Open parent task</a></div>` : ""}

        <label>Reports</label>
        <div id="d-reports"><div class="meta">Loading…</div></div>

        <label>Decisions</label>
        <div id="d-decisions"><div class="meta">Loading…</div></div>

        <label>Comments</label>
        ${t.comments.map((c) => `<div class="comment"><div class="meta">${esc(c.author)} · ${new Date(c.created_at).toLocaleString()}</div>${esc(c.body)}</div>`).join("") || `<div class="meta">None</div>`}
        <form id="d-comment-form" style="margin-top:8px">
          <textarea id="d-comment" placeholder="Add a comment" style="min-height:60px"></textarea>
          <div class="form-actions"><button class="ghost" type="submit">Comment</button></div>
        </form>`);

      const act = async (fn) => {
        try { await fn(); await opts.onChange(); openDetails(id); }
        catch (err) { el("d-error").textContent = err.message; }
      };
      document.querySelectorAll(".criteria-list input").forEach((cb) =>
        cb.addEventListener("change", () => act(() => apiCall("PATCH", `/api/tasks/${id}/criteria/${cb.dataset.pos}`, { checked: cb.checked }))),
      );
      document.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDetails(a.dataset.open); }));
      el("d-run")?.addEventListener("click", () => act(() => apiCall("POST", `/api/tasks/${id}/run`)));

      // Decisions linked to the task (task 015).
      fetch(`/api/decisions?status=all&task=${encodeURIComponent(t.identifier)}`).then((r) => r.json()).then(({ decisions }) => {
        const box = el("d-decisions");
        if (!box) return;
        box.innerHTML = decisions?.length
          ? decisions.map((d) => `<div class="comment"><a href="/decisions.html?status=all&decision=${encodeURIComponent(d.identifier)}"><span class="id">${esc(d.identifier)}</span> ${esc(d.title)}</a>
              <div class="meta">${esc(d.status)}${d.decided_by ? ` by ${esc(d.decided_by)}` : ""} · ${esc(d.requested_by)}</div></div>`).join("")
          : `<div class="meta">None${t.requires_approval ? ": an approved Decision is needed before review" : ""}</div>`;
      }).catch(() => {});

      // Reports saved on the task (R2). Click to read.
      fetch(`/api/tasks/${encodeURIComponent(id)}/reports`).then((r) => r.json()).then(({ reports }) => {
        const box = el("d-reports");
        if (!box) return;
        if (!reports?.length) { box.innerHTML = `<div class="meta">None</div>`; return; }
        box.innerHTML = reports.map((r) => `<div class="comment"><a href="#" data-report="${esc(r.id)}">${esc(r.title)}</a>
          <div class="meta">${esc(r.agent_id)} · ${new Date(r.created_at).toLocaleString()}</div><pre class="report" hidden></pre></div>`).join("");
        box.querySelectorAll("[data-report]").forEach((a) => a.addEventListener("click", async (e) => {
          e.preventDefault();
          const pre = a.parentElement.querySelector("pre");
          if (!pre.hidden) { pre.hidden = true; return; }
          const data = await (await fetch(`/api/tasks/${encodeURIComponent(id)}/reports/${encodeURIComponent(a.dataset.report)}`)).json();
          pre.textContent = data.markdown ?? data.error;
          pre.hidden = false;
        }));
      }).catch(() => {});
      el("d-close")?.addEventListener("click", () => {
        const unchecked = t.criteria.filter((c) => !c.checked).length;
        if (unchecked && !confirm(`${unchecked} criteria are not checked. Close anyway?`)) return;
        act(() => apiCall("POST", `/api/tasks/${id}/close`));
      });
      el("d-sendback")?.addEventListener("click", () => {
        const reason = prompt("What needs fixing?");
        if (reason) act(() => apiCall("POST", `/api/tasks/${id}/send-back`, { reason }));
      });
      el("d-cancel")?.addEventListener("click", () => {
        if (confirm(`Cancel ${t.identifier}?`)) act(() => apiCall("POST", `/api/tasks/${id}/cancel`));
      });
      el("d-comment-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const body = el("d-comment").value.trim();
        if (body) act(() => apiCall("POST", `/api/tasks/${id}/comments`, { body }));
      });
    }


    window.TaskPanel = {
      init(o) { opts = { ...opts, ...o }; },
      openNewTask,
      openDetails,
      close: closePanel,
    };
})();
