// Cmd+K command palette (SPEC-ui section 7). Loaded on every page by nav.js.
// Jump to menus, agents (their chat) and agent panels. "@name text" opens that agent's chat
// with "text" in the composer (not sent).

import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type Agent = { id: string; name: string; tier: "principal" | "lead" | "operator"; parent_id: string | null; area: string };
type Entry = { id: string; label: string; hint: string; href: string; group: "Menus" | "Agents" | "Agent panels" | "Recent"; keywords: string[] };

const MENUS: Array<[string, string]> = [
  ["Overview", "/"],
  ["Chat", "/chat.html"],
  ["Tasks", "/tasks.html"],
  ["Kanban", "/kanban.html"],
  ["Decisions", "/decisions.html"],
  ["Routines", "/routines.html"],
  ["Artifacts", "/artifacts.html"],
  ["Containers", "/containers.html"],
  ["Skills", "/skills.html"],
  ["Agents", "/agents.html"],
  ["Orchestrator", "/orchestrator.html"],
];

const RECENT_KEY = "flaretown.palette.recent";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    const next = [id, ...readRecent().filter((r) => r !== id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage may be unavailable */
  }
}

const chatHref = (agentId: string, extra = "") => `/chat.html?agent=${encodeURIComponent(agentId)}${extra}`;

function buildEntries(agents: Agent[]): Entry[] {
  const name = (id: string | null) => agents.find((a) => a.id === id)?.name ?? "";
  const entries: Entry[] = MENUS.map(([label, href]) => ({
    id: `menu:${href}`,
    label,
    hint: "Menu",
    href,
    group: "Menus",
    keywords: [label],
  }));
  for (const a of agents) {
    const hint = a.tier === "principal" ? "Principal" : a.tier === "lead" ? "Lead" : `Operator · ${name(a.parent_id)}`;
    entries.push({
      id: `agent:${a.id}`,
      label: `Chat with ${a.name}`,
      hint,
      href: chatHref(a.id),
      group: "Agents",
      keywords: [a.name, a.id, a.tier, a.area],
    });
    for (const [panel, title] of [
      ["config", "Config"],
      ["tasks", "Tasks"],
    ] as const) {
      entries.push({
        id: `panel:${a.id}:${panel}`,
        label: `${a.name} ${title}`,
        hint: `Open ${title.toLowerCase()} panel`,
        href: chatHref(a.id, `&panel=${panel}`),
        group: "Agent panels",
        keywords: [a.name, a.id, title],
      });
    }
  }
  return entries;
}

// "@Operator A fix the login test" → { agent: Operator A, draft: "fix the login test" }
function parseMention(input: string, agents: Agent[]): { agent: Agent; draft: string } | null {
  const text = input.trim().replace(/^@/, "");
  if (!text) return null;
  const lower = text.toLowerCase();
  const match = [...agents]
    .sort((a, b) => b.name.length - a.name.length)
    .find((a) => lower === a.name.toLowerCase() || lower.startsWith(`${a.name.toLowerCase()} `));
  if (!match) return null;
  return { agent: match, draft: text.slice(match.name.length).trim() };
}

function Palette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d: { agents?: Agent[] }) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, [open]);

  const entries = useMemo(() => buildEntries(agents), [agents]);
  const agentsOnly = search.trimStart().startsWith("@");
  const mention = useMemo(() => parseMention(search, agents), [search, agents]);
  const recent = useMemo(
    () => (open && !search ? readRecent().map((id) => entries.find((e) => e.id === id)).filter((e): e is Entry => Boolean(e)) : []),
    [open, search, entries],
  );

  const go = (entry: Pick<Entry, "id" | "href">) => {
    pushRecent(entry.id);
    setOpen(false);
    location.href = entry.href;
  };

  const visible = agentsOnly ? entries.filter((e) => e.group === "Agents") : entries;
  const groups = (["Menus", "Agents", "Agent panels"] as const).filter((g) => visible.some((e) => e.group === g));

  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Jump to">
      <Command.Input value={search} onValueChange={setSearch} placeholder="Jump to a menu or agent… (@name message)" />
      <Command.List>
        <Command.Empty>No results.</Command.Empty>

        {mention?.draft ? (
          <Command.Group heading="Message">
            <Command.Item
              forceMount
              value={`draft:${search}`}
              onSelect={() =>
                go({ id: `agent:${mention.agent.id}`, href: chatHref(mention.agent.id, `&draft=${encodeURIComponent(mention.draft)}`) })
              }
            >
              <span>
                Chat with {mention.agent.name}: <em>“{mention.draft}”</em>
              </span>
              <span className="ft-hint">Enter to open with the message ready</span>
            </Command.Item>
          </Command.Group>
        ) : null}

        {recent.length > 0 && (
          <Command.Group heading="Recent">
            {recent.map((e) => (
              <Command.Item key={`recent:${e.id}`} value={`recent:${e.id} ${e.label}`} onSelect={() => go(e)}>
                <span>{e.label}</span>
                <span className="ft-hint">{e.hint}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {groups.map((g) => (
          <Command.Group key={g} heading={g}>
            {visible
              .filter((e) => e.group === g)
              .map((e) => (
                <Command.Item
                  key={e.id}
                  value={`${e.id} ${e.label}`}
                  keywords={agentsOnly ? e.keywords.map((k) => `@${k}`).concat(e.keywords) : e.keywords}
                  onSelect={() => go(e)}
                >
                  <span>{e.label}</span>
                  <span className="ft-hint">{e.hint}</span>
                </Command.Item>
              ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="ft-footer">↑↓ to move · Enter to open · Esc to close · @ for agents</div>
    </Command.Dialog>
  );
}

const style = document.createElement("style");
style.textContent = `
  [cmdk-dialog] { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(640px, calc(100vw - 32px)); z-index: 101;
    background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 20px 60px color-mix(in srgb, #000 35%, transparent);
    overflow: hidden; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  [cmdk-overlay] { position: fixed; inset: 0; z-index: 100; background: color-mix(in srgb, #000 35%, transparent); }
  [cmdk-input] { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--fg); padding: 16px; font: inherit; font-size: 16px; outline: none; }
  [cmdk-list] { max-height: min(420px, 60vh); overflow-y: auto; padding: 6px; }
  [cmdk-group-heading] { padding: 8px 10px 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  [cmdk-item] { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
  [cmdk-item][data-selected="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  [cmdk-empty] { padding: 16px; color: var(--muted); text-align: center; }
  .ft-hint { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .ft-footer { padding: 8px 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
`;
document.head.appendChild(style);

const host = document.createElement("div");
document.body.appendChild(host);
createRoot(host).render(<Palette />);
