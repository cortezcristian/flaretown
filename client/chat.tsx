import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

// Which agent this page talks to: ?agent=<id> (default the Principal). Chat lives at
// /api/agents/<id>/chat (src/index.ts).
const AGENT_ID = new URLSearchParams(location.search).get("agent") || "principal";
const CHAT_BASE_PATH = `api/agents/${AGENT_ID}/chat`;
// From the Cmd+K palette: ?panel=tasks|config opens a side panel, ?draft=... pre-fills the composer.
const QUERY = new URLSearchParams(location.search);
const INITIAL_PANEL = (["tasks", "config", "container", "skills", "mcps"] as const).find((p) => p === QUERY.get("panel")) ?? null;
// Unsent text is kept per agent in localStorage, so a refresh doesn't lose it.
const DRAFT_KEY = `flaretown.chat.draft.${AGENT_ID}`;
function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage may be unavailable */
  }
}
// A ?draft= from Cmd+K wins over the saved draft.
const INITIAL_DRAFT = QUERY.get("draft") ?? readDraft();

type AgentInfo = { id: string; name: string; tier: "principal" | "lead" | "operator"; parent_id: string | null };
const CLASS_BY_TIER = { principal: "Principal", lead: "Lead", operator: "Operator" } as const;

const MIN_ROWS = 1;
const MAX_ROWS = 8;

// An IME commits a composition with Enter; never treat that as "send" (cloudflare-os keyboardEvent.ts).
function isImeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
}

// Grow with the content between MIN_ROWS and MAX_ROWS, then scroll (cloudflare-os useComposerEditorLayout.ts).
function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const styles = getComputedStyle(textarea);
  const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
  const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const border = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
  const min = lineHeight * MIN_ROWS + padding + border;
  const max = lineHeight * MAX_ROWS + padding + border;
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, min), max)}px`;
  textarea.style.overflow = textarea.scrollHeight > max ? "auto" : "hidden";
}

type ToolPart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function toolName(part: ToolPart): string {
  return part.toolName ?? part.type.replace(/^tool-/, "");
}

// One line per tool call, like cloudflare-os getToolCallSummary.
function toolSummary(part: ToolPart): string {
  const name = toolName(part);
  const out = (part.output ?? {}) as { identifier?: string; failed?: boolean; error?: string; tasks?: unknown[] };
  if (part.state === "output-error") return `${name} failed`;
  if (part.state !== "output-available") return `${name}…`;
  if (out.failed) return `${name} refused: ${out.error ?? "error"}`;
  switch (name) {
    case "tasks_create": return `Created task ${out.identifier ?? ""}`;
    case "tasks_list": return `Listed ${out.tasks?.length ?? 0} tasks`;
    case "tasks_get": return `Read ${out.identifier ?? "task"}`;
    case "tasks_update": return `Updated ${out.identifier ?? "task"}`;
    case "tasks_comment": return `Commented on ${out.identifier ?? "task"}`;
    case "tasks_check_criterion": return `Checked a criterion on ${out.identifier ?? "task"}`;
    case "tasks_close": return `Closed ${out.identifier ?? "task"}`;
    case "tasks_send_back": return `Sent back ${out.identifier ?? "task"}`;
    case "tasks_cancel": return `Cancelled ${out.identifier ?? "task"}`;
    case "exec": return "Ran code";
    case "activate_skill": return `Used skill ${String((part.input as { name?: unknown } | undefined)?.name ?? "")}`;
    case "read_skill_resource": return `Read ${String((part.input as { name?: unknown; path?: unknown } | undefined)?.path ?? "a skill file")}`;
    case "run_skill_script": return "Ran a skill script";
    case "decisions_request": return `Requested decision ${(part.output as { identifier?: string } | undefined)?.identifier ?? ""}`;
    case "decisions_add_evidence": return `Added evidence to ${(part.output as { identifier?: string } | undefined)?.identifier ?? "a decision"}`;
    case "decisions_withdraw": return "Withdrew a decision";
    case "sandbox_run": return "Ran command in sandbox";
    case "sandbox_status": return "Checked sandbox";
    case "sandbox_reset": return "Reset sandbox";
    case "mcps_list": return "Listed MCP servers";
    case "mcps_attach": return `Attached MCP server ${String((part.input as { server?: unknown } | undefined)?.server ?? "")}`;
    case "mcps_detach": return `Detached MCP server ${String((part.input as { server?: unknown } | undefined)?.server ?? "")}`;
    default:
      // MCP tools are named tool_<server>_<tool> by the Agents SDK.
      if (name.startsWith("tool_")) return `MCP ${name.slice(5).replace("_", " · ")}`;
      return name;
  }
}

// Code Mode (exec): show the source and the result separately.
function ExecRow({ part, failed, codeLabel }: { part: ToolPart; failed: boolean; codeLabel: string }) {
  const code = String((part.input as { command?: unknown } | undefined)?.command ?? "");
  // exec output: { command, cwd, backend, exitCode, stdout, stderr, result }. The command is
  // already shown above, so only the outcome is rendered.
  const out = part.output as { exitCode?: number; stdout?: string; stderr?: string; result?: unknown } | string | undefined;
  const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const sections: Array<[string, string]> = [];
  if (part.errorText) sections.push(["Error", part.errorText]);
  else if (typeof out === "string") sections.push(["Result", out]);
  else if (out) {
    if (out.result !== undefined) sections.push(["Result", fmt(out.result)]);
    if (out.stdout) sections.push(["Stdout", out.stdout]);
    if (out.stderr) sections.push(["Stderr", out.stderr]);
    if (out.exitCode !== undefined && out.exitCode !== 0) sections.push(["Exit code", String(out.exitCode)]);
    if (!sections.length) sections.push(["Result", fmt(out)]);
  }
  return (
    <details className={`tool exec${failed ? " failed" : ""}`}>
      <summary>{part.state === "output-error" ? "Code failed" : toolSummary(part)}</summary>
      <div className="label">{codeLabel}</div>
      <pre>{code}</pre>
      {sections.map(([label, text]) => (
        <div key={label}>
          <div className="label">{label}</div>
          <pre>{text}</pre>
        </div>
      ))}
    </details>
  );
}

function ToolRow({ part }: { part: ToolPart }) {
  const failed =
    part.state === "output-error" ||
    Boolean((part.output as { failed?: boolean } | undefined)?.failed) ||
    ((toolName(part) === "exec" || toolName(part) === "sandbox_run") &&
      Number((part.output as { exitCode?: number } | undefined)?.exitCode ?? 0) !== 0);
  if (toolName(part) === "exec") return <ExecRow part={part} failed={failed} codeLabel="Code" />;
  // Same output shape ({ exitCode, stdout, stderr }): command, then the outcome.
  if (toolName(part) === "sandbox_run") return <ExecRow part={part} failed={failed} codeLabel="Command" />;
  return (
    <details className={`tool${failed ? " failed" : ""}`}>
      <summary>{toolSummary(part)}</summary>
      <pre>{JSON.stringify({ input: part.input, output: part.output ?? part.errorText }, null, 2)}</pre>
    </details>
  );
}

type ResponseFormat = "markdown" | "plain";
type AgentConfig = {
  agent_id: string;
  model: string;
  response_format: ResponseFormat;
  compact_after_tokens: number;
  compact_after_default: number;
  compact_after_is_default: boolean;
  context_window: number;
  code_mode: boolean;
  code_mode_global: boolean;
  code_mode_active: boolean;
  sandbox_enabled: boolean;
  sandbox_internet: boolean;
  sandbox_persist: boolean;
  sandbox_global: boolean;
  sandbox_active: boolean;
  container_image: string;
  container_instance: string;
  container_instance_is_default: boolean;
};
type ConfigPatch = {
  model?: string;
  response_format?: ResponseFormat;
  compact_after_tokens?: number | null;
  code_mode?: boolean;
  sandbox_enabled?: boolean;
  sandbox_internet?: boolean;
  sandbox_persist?: boolean;
  container_image?: string;
  container_instance?: string | null;
};
type SandboxStatus = {
  running: boolean;
  started_at: string | null;
  internet: boolean;
  persist: boolean;
  image: string;
  instance: string;
  desktop: boolean;
  snapshot: { id: string; size: number; at: string } | null;
  profile: { size: number; at: string } | null;
  tier: { running: number; max: number };
};
type AgentSkill = { name: string; description: string; source: string; all_agents: boolean; assigned: boolean; active: boolean };

// Right panel "Skills" (task 017): what this agent can use, and which ones it used in this chat.
function SkillsPanel({ used, onCount }: { used: string[]; onCount: (n: number) => void }) {
  const [skills, setSkills] = useState<AgentSkill[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ skills: AgentSkill[] }>("GET", `/api/agents/${AGENT_ID}/skills`)
      .then((d) => {
        setSkills(d.skills);
        onCount(d.skills.filter((s) => s.active).length);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [onCount]);
  useEffect(load, [load]);
  if (!skills) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const toggle = async (name: string, on: boolean) => {
    const names = skills.filter((s) => s.assigned && s.name !== name).map((s) => s.name);
    if (on) names.push(name);
    setError("");
    try {
      const d = await api<{ skills: AgentSkill[] }>("PUT", `/api/agents/${AGENT_ID}/skills`, { skills: names });
      setSkills(d.skills);
      onCount(d.skills.filter((s) => s.active).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="skills-panel">
      <p className="muted">
        The agent sees each skill's name and description, and loads one when a task matches it. Changes apply on the next message.{" "}
        <a href="/skills.html">Manage skills</a>
      </p>
      {used.length > 0 && <p className="muted">Used in this chat: {used.join(", ")}</p>}
      <ul className="panel-list">
        {skills.map((s) => (
          <li key={s.name}>
            <label className="check" title={s.description}>
              <input type="checkbox" checked={s.active} disabled={s.all_agents} onChange={(e) => toggle(s.name, e.target.checked)} /> {s.name}
              {s.all_agents && <span className="muted"> · all agents</span>}
            </label>
            <div className="muted">{s.description}</div>
          </li>
        ))}
      </ul>
      {!skills.length && <p className="muted">No skills installed.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

type AgentMcpTool = { name: string; key: string; description: string; read_only: boolean };
type AgentMcp = {
  server_id: string;
  name: string;
  auth: string;
  policy: string;
  status: string;
  auth_url: string | null;
  error: string | null;
  tools: AgentMcpTool[];
};
type McpServerSummary = { id: string; name: string; auth: string; policy: string; missing_secrets: string[] };

// Right panel "MCPs" (task 018): this agent's MCP servers, status, tools; Connect for OAuth.
function McpsPanel({ onCount }: { onCount: (n: number, attention: boolean) => void }) {
  const [servers, setServers] = useState<AgentMcp[] | null>(null);
  const [catalog, setCatalog] = useState<McpServerSummary[]>([]);
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(QUERY.get("mcp_error") ?? "");
  const load = useCallback(() => {
    api<{ servers: AgentMcp[] }>("GET", `/api/agents/${AGENT_ID}/mcps`)
      .then((d) => {
        setServers(d.servers);
        onCount(d.servers.length, d.servers.some((s) => s.status !== "ready"));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    api<{ servers: McpServerSummary[] }>("GET", "/api/mcps")
      .then((d) => setCatalog(d.servers.filter((s) => s.policy !== "off")))
      .catch(() => {});
  }, [onCount]);
  useEffect(load, [load]);
  // While a server is still connecting (or waiting for OAuth in another tab), poll.
  useEffect(() => {
    if (!servers?.some((s) => s.status === "connecting" || s.status === "authenticating" || s.status === "pending")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [servers, load]);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      const out = (await fn()) as { auth_url?: string | null; status?: string } | undefined;
      if (out?.status === "authenticating" && out.auth_url) window.open(out.auth_url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
    load();
  };
  if (!servers) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const attached = new Set(servers.map((s) => s.server_id));
  const available = catalog.filter((s) => !attached.has(s.id));
  return (
    <div className="skills-panel">
      <p className="muted">
        Tools from these servers show up in the agent's next message. <a href="/mcps.html">Manage MCPs</a>
      </p>
      <ul className="panel-list">
        {servers.map((s) => (
          <li key={s.server_id}>
            <div>
              <strong>{s.name}</strong> <span className={`mcp-status ${s.status}`}>{s.status}</span>
              {s.policy === "ask" && <span className="muted"> · asks before writes</span>}
              {s.policy === "off" && <span className="muted"> · off</span>}
            </div>
            {s.error && <div className="error">{s.error}</div>}
            {s.tools.length > 0 && (
              <details>
                <summary className="muted">{s.tools.length} tool(s)</summary>
                <ul className="mcp-tools">
                  {s.tools.map((t) => (
                    <li key={t.key} title={t.description}>
                      <code>{t.name}</code>
                      {t.read_only && <span className="muted"> · read-only</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row-actions">
              {s.status === "authenticating" && s.auth_url ? (
                <a className="button" href={s.auth_url} target="_blank" rel="noopener">
                  Connect
                </a>
              ) : (
                <button type="button" disabled={Boolean(busy)} onClick={() => act(`re-${s.server_id}`, () => api("POST", `/api/agents/${AGENT_ID}/mcps/${s.server_id}`))}>
                  {busy === `re-${s.server_id}` ? "…" : "Reconnect"}
                </button>
              )}
              <button type="button" disabled={Boolean(busy)} onClick={() => act(`rm-${s.server_id}`, () => api("DELETE", `/api/agents/${AGENT_ID}/mcps/${s.server_id}`))}>
                Detach
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!servers.length && <p className="muted">No MCP servers yet.</p>}
      {available.length > 0 && (
        <div className="row-actions">
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Add a server…</option>
            {available.map((s) => (
              <option key={s.id} value={s.id} disabled={s.missing_secrets.length > 0}>
                {s.name}
                {s.auth === "oauth" ? " (sign in)" : ""}
                {s.missing_secrets.length ? ` (needs ${s.missing_secrets.join(", ")})` : ""}
              </option>
            ))}
          </select>
          <button type="button" disabled={!add || Boolean(busy)} onClick={() => act("add", () => api("POST", `/api/agents/${AGENT_ID}/mcps`, { server: add }).then((r) => (setAdd(""), r)))}>
            {busy === "add" ? "…" : "Add"}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

type ImageInfo = { name: string; description: string; default_instance: string; desktop: boolean };
const INSTANCES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];
const imageLabel = (i: ImageInfo) =>
  i.name === "debian" ? "Debian (Node, npm)" : i.name === "desktop" ? "Desktop (Chromium, noVNC)" : `Custom: ${i.name}`;

// Right panel "Container" (task 014): the agent's container while you chat. Desktop images show
// the live noVNC view, served by this same Worker at /container/<agent-id>/view (same origin).
function ContainerPanel({ status, onRefresh }: { status: SandboxStatus | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const viewUrl = `/container/${encodeURIComponent(AGENT_ID)}/view`;
  if (!status) return <p className="muted">Loading…</p>;
  const act = async (what: "start" | "stop") => {
    if (what === "stop" && !confirm("Stop this container? The browser profile and (with Keep files) its files are saved first.")) return;
    setBusy(what);
    setError("");
    try {
      const res = await api<{ ok?: boolean; error?: string }>("POST", `/api/containers/${AGENT_ID}/${what}`);
      if (res.ok === false) setError(res.error ?? "Could not start.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
      onRefresh();
    }
  };
  return (
    <div className="container-panel">
      <p className="muted">
        <span className={`cdot${status.running ? " on" : ""}`} /> {status.running ? "Running" : "Stopped"} · {status.image} ·{" "}
        {status.instance} · Internet {status.internet ? "on" : "off"}
      </p>
      <div className="row-buttons">
        {status.running ? (
          <button type="button" className="ask" disabled={Boolean(busy)} onClick={() => act("stop")}>
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="button" className="ask" disabled={Boolean(busy)} onClick={() => act("start")}>
            {busy === "start" ? "Starting…" : "Start"}
          </button>
        )}
        {status.desktop && (
          <a className="ask" href={viewUrl} target="_blank" rel="noopener">
            Open in new tab
          </a>
        )}
        <a className="ask" href="/containers.html">
          All containers
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {status.desktop ? (
        status.running ? (
          <iframe className="vnc" src={viewUrl} title="Container desktop" allow="clipboard-read; clipboard-write" />
        ) : (
          <p className="muted">Start the container to see its desktop.</p>
        )
      ) : (
        <p className="muted">This image has no desktop. The agent works in it with sandbox_run.</p>
      )}
    </div>
  );
}

// Container image and instance (task 014). Changing either restarts the container.
function ImageSelect({ config, onChange }: { config: AgentConfig; onChange: (patch: ConfigPatch) => void }) {
  const [images, setImages] = useState<ImageInfo[]>([]);
  useEffect(() => {
    api<{ images: ImageInfo[] }>("GET", "/api/containers/images")
      .then((d) => setImages(d.images))
      .catch(() => setImages([{ name: "debian", description: "", default_instance: "lite", desktop: false }]));
  }, []);
  const current = images.find((i) => i.name === config.container_image);
  return (
    <div className="pair">
      <div>
        <label htmlFor="cfg-image">Image</label>
        <select id="cfg-image" value={config.container_image} onChange={(e) => onChange({ container_image: e.target.value })}>
          {!current && <option value={config.container_image}>{config.container_image}</option>}
          {images.map((i) => (
            <option key={i.name} value={i.name}>
              {imageLabel(i)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="cfg-instance">Instance</label>
        <select
          id="cfg-instance"
          value={config.container_instance_is_default ? "" : config.container_instance}
          onChange={(e) => onChange({ container_instance: e.target.value || null })}
        >
          <option value="">Default ({current?.default_instance ?? config.container_instance})</option>
          {INSTANCES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Sandbox settings, live status and Restart / Reset files (task 013).
function SandboxSetting({ config, onChange }: { config: AgentConfig; onChange: (patch: ConfigPatch) => void }) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    api<SandboxStatus>("GET", `/api/agents/${AGENT_ID}/sandbox`)
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(() => {
    if (config.sandbox_enabled) refresh();
  }, [refresh, config.sandbox_enabled, config.sandbox_internet, config.sandbox_persist]);
  const act = async (what: "restart" | "reset") => {
    if (what === "reset" && !confirm("Stop the sandbox and delete its saved files?")) return;
    setBusy(what);
    setError("");
    try {
      setStatus(await api<SandboxStatus>("POST", `/api/agents/${AGENT_ID}/sandbox/${what}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };
  const box = (key: "sandbox_enabled" | "sandbox_internet" | "sandbox_persist", text: string, disabled = false) => (
    <label className="check">
      <input type="checkbox" checked={config[key]} disabled={disabled} onChange={(e) => onChange({ [key]: e.target.checked })} /> {text}
    </label>
  );
  const kb = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  return (
    <>
      {box("sandbox_enabled", "Container")}
      {config.sandbox_enabled && (
        <div className="sub">
          <ImageSelect config={config} onChange={onChange} />
          {box("sandbox_internet", "Internet")}
          {box("sandbox_persist", "Keep files across restarts")}
        </div>
      )}
      <p className="muted">
        {!config.sandbox_global
          ? "Disabled globally. Turn it on in Orchestrator to use it (Containers, billable)."
          : "A Linux container for this agent, billable while it runs. Changing image, instance or Internet restarts it."}
      </p>
      {config.sandbox_enabled && status && (
        <p className="muted">
          {status.running ? "Running" : "Stopped"} · Internet {status.internet ? "on" : "off"} ·{" "}
          {status.snapshot ? `files saved ${new Date(status.snapshot.at).toLocaleString()} (${kb(status.snapshot.size)})` : "no saved files"} ·{" "}
          {status.tier.running}/{status.tier.max} running in this tier
        </p>
      )}
      {config.sandbox_enabled && (
        <div className="row-buttons">
          <button type="button" className="ask" disabled={Boolean(busy)} onClick={() => act("restart")}>
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button type="button" className="ask" disabled={Boolean(busy)} onClick={() => act("reset")}>
            {busy === "reset" ? "Resetting…" : "Reset files"}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
type Model = { id: string; name: string };
type TaskSummary = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  criteria_total: number;
  criteria_checked: number;
};
type Panel = "tasks" | "config" | "container" | "skills" | "mcps" | null;

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

function MessageText({ text, format }: { text: string; format: ResponseFormat }) {
  if (format === "plain") return <p className="plain">{text}</p>;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers that block the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy" onClick={copy} aria-label={copied ? "Copied" : "Copy response"} title={copied ? "Copied" : "Copy response"}>
      {copied ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
        </svg>
      )}
    </button>
  );
}

function TasksPanel({
  tasks,
  busy,
  onAskStatus,
}: {
  tasks: TaskSummary[];
  busy: boolean;
  onAskStatus: (task: TaskSummary) => void;
}) {
  if (tasks.length === 0) return <p className="muted">No open tasks assigned.</p>;
  return (
    <ul className="panel-list">
      {tasks.map((t) => (
        <li key={t.id}>
          <a href={`/tasks.html`}>
            <span className="tid">{t.identifier}</span> {t.title}
          </a>
          <div className="muted">
            {t.state.replace("_", " ")} · criteria {t.criteria_checked}/{t.criteria_total}
          </div>
          <button type="button" className="ask" disabled={busy} onClick={() => onAskStatus(t)}>
            Ask status
          </button>
        </li>
      ))}
    </ul>
  );
}

const fmt = (n: number) => n.toLocaleString("en");

// Compaction threshold (SPEC-agents 9): default 70% of the model window, editable per agent.
function CompactSetting({ config, onChange }: { config: AgentConfig; onChange: (patch: ConfigPatch) => void }) {
  const [value, setValue] = useState(String(config.compact_after_tokens));
  useEffect(() => setValue(String(config.compact_after_tokens)), [config.compact_after_tokens]);
  const commit = () => {
    const n = Number(value.replace(/[,_\s]/g, ""));
    if (Number.isFinite(n) && n !== config.compact_after_tokens) onChange({ compact_after_tokens: Math.round(n) });
    else setValue(String(config.compact_after_tokens));
  };
  return (
    <>
      <label htmlFor="cfg-compact">Compact context after (tokens)</label>
      <input
        id="cfg-compact"
        className="cfg-input"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <p className="muted">
        {config.compact_after_is_default ? "Default" : "Custom"}: older messages are summarized past this size. Default for this
        model: {fmt(config.compact_after_default)} (70% of {fmt(config.context_window)}).{" "}
        {!config.compact_after_is_default && (
          <button type="button" className="linklike" onClick={() => onChange({ compact_after_tokens: null })}>
            Reset to default
          </button>
        )}
      </p>
      <p className="muted">Type /compact in the chat to compact now.</p>
    </>
  );
}

function ConfigPanel({
  config,
  models,
  onChange,
  error,
}: {
  config: AgentConfig | null;
  models: Model[];
  onChange: (patch: ConfigPatch) => void;
  error: string;
}) {
  if (!config) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <div className="config">
      <label htmlFor="cfg-model">Model</label>
      <select id="cfg-model" value={config.model} onChange={(e) => onChange({ model: e.target.value })}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <p className="muted">Workers AI. Applies from the next message.</p>

      <label>Responses</label>
      <div className="segmented">
        {(["markdown", "plain"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={config.response_format === f ? "active" : ""}
            onClick={() => onChange({ response_format: f })}
          >
            {f === "markdown" ? "Markdown" : "Plain text"}
          </button>
        ))}
      </div>
      <CompactSetting config={config} onChange={onChange} />

      <label className="check">
        <input type="checkbox" checked={config.code_mode} onChange={(e) => onChange({ code_mode: e.target.checked })} /> Code Mode
      </label>
      <p className="muted">
        {config.code_mode_global
          ? "Gives the agent an exec tool that runs JavaScript on Dynamic Workers (billable). No internet; it can only call this agent's tools."
          : "Disabled globally. Turn it on in Orchestrator to use it (Dynamic Workers, billable)."}
      </p>

      <SandboxSetting config={config} onChange={onChange} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function AgentSelector({ agents, current }: { agents: AgentInfo[]; current: string }) {
  const leads = agents.filter((a) => a.tier === "lead");
  const label = (a: AgentInfo) => (a.tier === "operator" ? `   ${a.name}` : a.name);
  const ordered: AgentInfo[] = [
    ...agents.filter((a) => a.tier === "principal"),
    ...leads.flatMap((l) => [l, ...agents.filter((a) => a.tier === "operator" && a.parent_id === l.id)]),
  ];
  return (
    <select
      className="agent-select"
      value={current}
      onChange={(e) => {
        // Blur the current chat while the next one loads (full page load).
        const next = agents.find((a) => a.id === e.target.value);
        document.body.dataset.switching = `Loading ${next?.name ?? "chat"}…`;
        document.body.classList.add("switching");
        location.search = `?agent=${encodeURIComponent(e.target.value)}`;
      }}
    >
      {ordered.map((a) => (
        <option key={a.id} value={a.id}>
          {label(a)} {a.tier === "principal" ? "" : `(${a.tier})`}
        </option>
      ))}
    </select>
  );
}

// True when the latest message is from the assistant and already shows some text, so the
// "working" bubble isn't needed (the reply itself is streaming).
function messageText(m: { parts: Array<{ type: string; text?: string }> }): string {
  return m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n\n").trim();
}

function lastAssistantHasText(messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>): boolean {
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === "assistant" && last.parts.some((p) => p.type === "text" && (p.text ?? "").trim()));
}

function Chat({ agents }: { agents: AgentInfo[] }) {
  const me = agents.find((a) => a.id === AGENT_ID);
  const agent = useAgent({ agent: CLASS_BY_TIER[me?.tier ?? "principal"], basePath: CHAT_BASE_PATH });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const [input, setInput] = useState(INITIAL_DRAFT);
  useEffect(() => writeDraft(input), [input]);
  const [panel, setPanel] = useState<Panel>(INITIAL_PANEL);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [configError, setConfigError] = useState("");
  const [notice, setNotice] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Follow new messages while the user is at the bottom; stop if they scroll up to read.
  const pinnedRef = useRef(true);
  const busy = status === "submitted" || status === "streaming";
  const format: ResponseFormat = config?.response_format ?? "markdown";

  const loadTasks = useCallback(async () => {
    try {
      const data = await api<{ tasks: TaskSummary[] }>("GET", `/api/tasks?filter=open&assignee=${AGENT_ID}`);
      setTasks(data.tasks);
    } catch {
      /* keep last list */
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    api<AgentConfig>("GET", `/api/agents/${AGENT_ID}/config`)
      .then(setConfig)
      .catch((err) => setConfigError(`Couldn't load config: ${err instanceof Error ? err.message : String(err)}`));
    api<{ models: Model[] }>("GET", "/api/models").then((d) => setModels(d.models)).catch(() => {});
  }, [loadTasks]);

  // Refresh the task count when a turn ends (the agent may have created or closed tasks).
  useEffect(() => {
    if (!busy) void loadTasks();
  }, [busy, loadTasks]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [input]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    if (text === "/compact") {
      setInput("");
      setNotice("Compacting context…");
      api<{ compacted: boolean }>("POST", `/api/agents/${AGENT_ID}/compact`)
        .then((r) => setNotice(r.compacted ? "Context compacted." : "Nothing to compact yet."))
        .catch((err) => setNotice(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    pinnedRef.current = true;
    sendMessage({ text });
    setInput("");
    textareaRef.current?.focus();
  };

  // Shift+Enter (or Cmd/Ctrl+Enter) sends. Plain Enter adds a new line.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const updateConfig = async (patch: ConfigPatch) => {
    if (!config) return;
    const previous = config;
    const toggles = [patch.code_mode, patch.sandbox_enabled, patch.sandbox_internet, patch.sandbox_persist, patch.container_image];
    if (patch.model || patch.response_format || toggles.some((t) => t !== undefined)) setConfig({ ...config, ...(patch as Partial<AgentConfig>) });
    setConfigError("");
    try {
      setConfig(await api<AgentConfig>("PATCH", `/api/agents/${AGENT_ID}/config`, patch));
    } catch (err) {
      setConfig(previous);
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  };

  const askStatus = (task: TaskSummary) => {
    if (busy) return;
    pinnedRef.current = true;
    sendMessage({ text: `What is the status of ${task.identifier}?` });
  };

  const toggle = (p: Exclude<Panel, null>) => setPanel((current) => (current === p ? null : p));

  // Keep the open panel in the URL (?panel=...), so a reload or a shared link reopens it.
  useEffect(() => {
    const url = new URL(location.href);
    if (panel) url.searchParams.set("panel", panel);
    else url.searchParams.delete("panel");
    history.replaceState(null, "", url);
  }, [panel]);

  // MCPs: count and "needs attention" for the header chip (task 018).
  const [mcpCount, setMcpCount] = useState(0);
  const [mcpAttention, setMcpAttention] = useState(false);
  const onMcpCount = useCallback((n: number, attention: boolean) => {
    setMcpCount(n);
    setMcpAttention(attention);
  }, []);
  useEffect(() => {
    api<{ servers: AgentMcp[] }>("GET", `/api/agents/${AGENT_ID}/mcps`)
      .then((d) => onMcpCount(d.servers.length, d.servers.some((s) => s.status !== "ready")))
      .catch(() => {});
  }, [onMcpCount]);

  // Skills: count for the header button, and skills activated in this chat (from tool rows).
  const [skillCount, setSkillCount] = useState<number | null>(null);
  useEffect(() => {
    api<{ skills: AgentSkill[] }>("GET", `/api/agents/${AGENT_ID}/skills`)
      .then((d) => setSkillCount(d.skills.filter((s) => s.active).length))
      .catch(() => {});
  }, []);
  const usedSkills = [
    ...new Set(
      messages.flatMap((m) =>
        m.parts
          .filter((p) => isToolPart(p) && toolName(p as ToolPart) === "activate_skill")
          .map((p) => String(((p as ToolPart).input as { name?: unknown } | undefined)?.name ?? ""))
          .filter(Boolean),
      ),
    ),
  ];

  // Container status for the header chip and the Container panel (task 014).
  const [container, setContainer] = useState<SandboxStatus | null>(null);
  const hasContainer = Boolean(config?.sandbox_enabled);
  const loadContainer = useCallback(() => {
    api<SandboxStatus>("GET", `/api/agents/${AGENT_ID}/sandbox`)
      .then(setContainer)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!hasContainer) return;
    loadContainer();
    const t = setInterval(loadContainer, panel === "container" ? 5000 : 15000);
    return () => clearInterval(t);
  }, [hasContainer, loadContainer, panel, busy]);

  return (
    <div className="shell">
      <div className="chat">
        <header>
          <div className="who">
            <span className="dot" /> <AgentSelector agents={agents} current={AGENT_ID} />
            <span className={`status${busy ? " working" : ""}`}>{busy ? "working…" : "idle"}</span>
          </div>
          <nav className="menu">
            <button type="button" className={panel === "tasks" ? "active" : ""} onClick={() => toggle("tasks")}>
              Tasks <span className="badge">{tasks.length}</span>
            </button>
            <button type="button" className={panel === "skills" ? "active" : ""} onClick={() => toggle("skills")}>
              Skills {skillCount !== null && <span className="badge">{skillCount}</span>}
            </button>
            <button
              type="button"
              className={`chip${panel === "mcps" ? " active" : ""}`}
              onClick={() => toggle("mcps")}
              title={mcpAttention ? "A server needs attention" : "MCP servers"}
            >
              {mcpCount > 0 && <span className={`cdot${mcpAttention ? " warn" : " on"}`} />} MCPs {mcpCount > 0 && <span className="badge">{mcpCount}</span>}
            </button>
            {hasContainer && (
              <button
                type="button"
                className={`chip${panel === "container" ? " active" : ""}`}
                onClick={() => toggle("container")}
                title={container ? `${container.image} · ${container.running ? "running" : "stopped"}` : "Container"}
              >
                <span className={`cdot${container?.running ? " on" : ""}`} /> Container
              </button>
            )}
            <a className="menu-link" href={`/artifacts.html?agent=${encodeURIComponent(AGENT_ID)}`}>
              Artifacts
            </a>
            <button type="button" className={panel === "config" ? "active" : ""} onClick={() => toggle("config")}>
              Config
            </button>
          </nav>
        </header>
        {notice && (
          <div className="notice" onClick={() => setNotice("")}>
            {notice}
          </div>
        )}
        <ul
          className="messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {messages.map((m) => (
            <li key={m.id} className={m.role}>
              {m.parts.map((part, i) =>
                part.type === "text" ? (
                  m.role === "assistant" ? (
                    <MessageText key={i} text={part.text} format={format} />
                  ) : (
                    <p key={i} className="plain">{part.text}</p>
                  )
                ) : isToolPart(part) ? (
                  <ToolRow key={i} part={part as ToolPart} />
                ) : null,
              )}
              {m.role === "assistant" && messageText(m) && <CopyButton text={messageText(m)} />}
            </li>
          ))}
          {busy && !lastAssistantHasText(messages) && (
            <li className="assistant typing" aria-live="polite">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="muted">{me?.name ?? "Agent"} is working…</span>
            </li>
          )}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            placeholder={`Message ${me?.name ?? "the agent"} (Shift+Enter to send)`}
            rows={MIN_ROWS}
            autoFocus
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="send" aria-label="Send" title="Send" disabled={busy || !input.trim()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>

      {panel && (
        <aside className="side">
          <div className="side-head">
            <h2>{panel === "tasks" ? `Tasks (${tasks.length})` : panel === "container" ? "Container" : panel === "skills" ? "Skills" : panel === "mcps" ? "MCPs" : "Config"}</h2>
            <button type="button" className="close" aria-label="Close panel" onClick={() => setPanel(null)}>
              ×
            </button>
          </div>
          {panel === "tasks" ? (
            <TasksPanel tasks={tasks} busy={busy} onAskStatus={askStatus} />
          ) : panel === "container" ? (
            <ContainerPanel status={container} onRefresh={loadContainer} />
          ) : panel === "skills" ? (
            <SkillsPanel used={usedSkills} onCount={setSkillCount} />
          ) : panel === "mcps" ? (
            <McpsPanel onCount={onMcpCount} />
          ) : (
            <ConfigPanel config={config} models={models} onChange={updateConfig} error={configError} />
          )}
        </aside>
      )}
    </div>
  );
}

// Blurred placeholder of the chat while agents and messages load (same markup as chat.html).
function ChatSkeleton({ label }: { label: string }) {
  return (
    <div className="shell skeleton" aria-busy="true">
      <div className="chat">
        <header>
          <div className="who">
            <span className="dot" />
            <span className="sk-line" style={{ width: 150 }} />
          </div>
          <div className="menu">
            <span className="sk-line" style={{ width: 190 }} />
          </div>
        </header>
        <ul className="messages">
          <li className="sk-bubble user" style={{ width: "45%", height: 44 }} />
          <li className="sk-bubble" style={{ width: "75%", height: 96 }} />
          <li className="sk-bubble user" style={{ width: "35%", height: 44 }} />
          <li className="sk-bubble" style={{ width: "65%", height: 72 }} />
        </ul>
        <div className="sk-composer" />
      </div>
      <div className="sk-overlay">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>{" "}
        {label}
      </div>
    </div>
  );
}

function App() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ agents: AgentInfo[] }>("GET", "/api/agents")
      .then((d) => setAgents(d.agents))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  if (error) return <p className="error" style={{ padding: 16 }}>Couldn't load agents: {error}</p>;
  if (!agents) return <ChatSkeleton label="Loading chat…" />;
  const me = agents.find((a) => a.id === AGENT_ID);
  if (!me) return <p className="error" style={{ padding: 16 }}>No agent {AGENT_ID}.</p>;
  // useAgentChat suspends while it fetches the message history.
  return (
    <Suspense fallback={<ChatSkeleton label={`Loading ${me.name}…`} />}>
      <Chat agents={agents} />
    </Suspense>
  );
}

// Coming back with the browser's back button restores the page from cache: drop the blur.
window.addEventListener("pageshow", () => document.body.classList.remove("switching"));

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
