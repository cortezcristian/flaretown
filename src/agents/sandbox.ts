// One container per agent: the container attached to the agent's own Durable Object
// (this.ctx.container). SPEC-sandbox (task 013) and SPEC-containers 0 (task 014: images,
// desktop viewer, browser profile in R2). Pattern from
// https://developers.cloudflare.com/agents/tools/sandbox/ and
// https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/

import { type AgentConfig, getAgentConfig } from "../services/agentConfig";
import { DEBIAN_IMAGE, imageInfo, imagesFrom, profileKey } from "../services/containers";
import { getOrchestratorSettings } from "../services/settings";

export const SANDBOX_IMAGE = DEBIAN_IMAGE; // the "debian" image
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 10_000;
const NOVNC_PORT = 6080;
// Fake host the desktop image uses to save/restore its browser profile (intercepted, see start()).
const PROFILE_HOST = "flaretown.internal";

// Durable Object storage keys.
const SNAPSHOT_KEY = "sandbox:snapshot"; // { id, size, at, image }
const STARTED_KEY = "sandbox:started"; // { internet, image, instance, at }

type Tier = "principal" | "lead" | "operator";
type SnapshotInfo = { id: string; size: number; at: string; image?: string };
type StartedInfo = { internet: boolean; image: string; instance: string; at: string };

export type SandboxResult = { exitCode: number; stdout: string; stderr: string } | { error: string; failed: true };

const MAX_KEY: Record<Tier, "sandbox_max_principal" | "sandbox_max_leads" | "sandbox_max_operators"> = {
  principal: "sandbox_max_principal",
  lead: "sandbox_max_leads",
  operator: "sandbox_max_operators",
};
const TIER_LABEL: Record<Tier, string> = { principal: "Principal", lead: "Leads", operator: "Operators" };

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;background:#0f0f12;color:#a1a1aa;text-align:center}
button{margin-top:12px;border:0;border-radius:8px;padding:6px 14px;background:#f6821f;color:#fff;font:inherit;font-weight:600;cursor:pointer}</style>
<div>${body}</div>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export class AgentSandbox {
  // Set when a command ran in this turn; the agent snapshots after the turn when persist is on.
  usedThisTurn = false;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private agentId: () => string,
    private tier: () => Tier,
  ) {}

  private get container(): Container | undefined {
    return this.ctx.container;
  }

  private config(): Promise<AgentConfig> {
    return getAgentConfig(this.env.DB_CORE, this.agentId());
  }

  // Images deployed for this agent class (wrangler.jsonc `images`) plus the stock debian one.
  images() {
    return imagesFrom(Object.keys(this.container?.images ?? {}));
  }

  // Count of other agents of this tier with a running sandbox (used within the idle timeout).
  private async runningInTier(): Promise<number> {
    const since = new Date(Date.now() - INACTIVITY_TIMEOUT_MS).toISOString();
    const row = await this.env.DB_CORE.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE tier = ? AND id != ? AND status = 'active' AND sandbox_last_used_at > ?",
    )
      .bind(this.tier(), this.agentId(), since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  private async markUsed(): Promise<void> {
    await this.env.DB_CORE.prepare("UPDATE agents SET sandbox_last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), this.agentId())
      .run();
  }

  private async markStopped(): Promise<void> {
    await this.env.DB_CORE.prepare("UPDATE agents SET sandbox_last_used_at = NULL WHERE id = ?").bind(this.agentId()).run();
    await this.ctx.storage.delete(STARTED_KEY);
  }

  // Called from the agent's constructor: a restarted agent sets the idle timeout again.
  onAgentStart(): void {
    const container = this.container;
    if (container?.running) {
      void this.ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
      this.watch(container);
    }
  }

  // Clear the "running" mark when the container exits (idle stop, crash, destroy).
  private watch(container: Container): void {
    container
      .monitor()
      .catch(() => {})
      .finally(() => this.markStopped().catch((err) => console.error("sandbox markStopped failed", err)));
  }

  // Route the desktop image's profile sync host to our ProfileSync entrypoint (R2, this agent only).
  private async interceptProfileHost(container: Container): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exportsAny = this.ctx.exports as any;
    const binding = exportsAny.ProfileSync({ props: { agentId: this.agentId() } }) as Fetcher;
    await container.interceptOutboundHttp(PROFILE_HOST, binding);
  }

  private async ensureStarted(config: AgentConfig): Promise<{ error: string } | null> {
    const container = this.container;
    if (!container) return { error: "No container is configured for this agent class (wrangler.jsonc containers)." };
    if (container.running) return null;

    const settings = await getOrchestratorSettings(this.env.DB_CORE);
    const max = settings[MAX_KEY[this.tier()]];
    const running = await this.runningInTier();
    if (running >= max) {
      return { error: `No free sandbox: ${running} ${TIER_LABEL[this.tier()]} already running (max ${max}). Change the limit in Settings.` };
    }

    const imageName = config.container_image;
    const imageRef = imageName === "debian" ? SANDBOX_IMAGE : container.images[imageName];
    if (!imageRef) {
      return { error: `Image "${imageName}" is not deployed. Add it to wrangler.jsonc images (containers/README.md) and deploy, or pick another image.` };
    }
    // A snapshot only restores on the image it was taken from.
    let snapshot = config.sandbox_persist ? await this.ctx.storage.get<SnapshotInfo>(SNAPSHOT_KEY) : undefined;
    if (snapshot && (snapshot.image ?? "debian") !== imageName) snapshot = undefined;

    const desktop = imageInfo(imageName).desktop;
    // Intercept before start so the boot-time profile pull already goes through; if the API only
    // accepts it on a running container, retry right after start.
    let intercepted = !desktop;
    if (desktop) intercepted = await this.interceptProfileHost(container).then(() => true, () => false);
    // The stock debian image exits right away: keep it alive. Our and custom images run their own CMD.
    const base = {
      ...(imageName === "debian" ? { entrypoint: ["sleep", "infinity"] } : {}),
      enableInternet: config.sandbox_internet,
      instance: config.container_instance,
    };
    container.start(snapshot ? { ...base, containerSnapshot: { id: snapshot.id } } : { ...base, image: imageRef });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    if (!intercepted) await this.interceptProfileHost(container).catch((err) => console.error("profile intercept failed", err));
    await this.ctx.storage.put<StartedInfo>(STARTED_KEY, {
      internet: config.sandbox_internet,
      image: imageName,
      instance: config.container_instance,
      at: new Date().toISOString(),
    });
    this.watch(container);
    return null;
  }

  private async exec(command: string, timeoutS = COMMAND_TIMEOUT_S) {
    // `timeout` stops the command and every process it started.
    const proc = await this.container!.exec(["timeout", "--kill-after=5", String(timeoutS), "bash", "-lc", command]);
    const output = await proc.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout).slice(-MAX_OUTPUT_CHARS),
      stderr: decoder.decode(output.stderr).slice(-MAX_OUTPUT_CHARS),
    };
  }

  async run(command: string): Promise<SandboxResult> {
    const config = await this.config();
    if (!config.sandbox_active) {
      return { error: config.sandbox_global ? "Sandbox is off for this agent." : "Sandbox is disabled globally.", failed: true };
    }
    try {
      const startError = await this.ensureStarted(config);
      if (startError) return { ...startError, failed: true };
      const result = await this.exec(command);
      await this.markUsed();
      this.usedThisTurn = true;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A stored snapshot that can't be restored: say so, keep the id (sandbox_reset clears it).
      if (/snapshot/i.test(message)) {
        return { error: `${message}. Files were not restored; use sandbox_reset to start clean.`, failed: true };
      }
      return { error: message, failed: true };
    }
  }

  // Start the container without running anything (Containers section, desktop viewer).
  async boot(): Promise<{ ok: boolean; error?: string }> {
    const config = await this.config();
    if (!config.sandbox_active) return { ok: false, error: config.sandbox_global ? "Sandbox is off for this agent." : "Sandbox is disabled globally." };
    const startError = await this.ensureStarted(config).catch((err) => ({ error: String(err) }));
    if (startError) return { ok: false, error: startError.error };
    await this.markUsed();
    return { ok: true };
  }

  // After a turn that used the sandbox: keep its files when persist is on.
  async afterTurn(): Promise<void> {
    if (!this.usedThisTurn) return;
    this.usedThisTurn = false;
    const config = await this.config();
    if (config.sandbox_persist) await this.snapshot(config.container_image);
  }

  private async snapshot(image: string): Promise<SnapshotInfo | null> {
    const container = this.container;
    if (!container?.running) return null;
    const snap = await container.snapshotContainer({ name: "workspace" });
    const info = { id: snap.id, size: snap.size, at: new Date().toISOString(), image };
    await this.ctx.storage.put(SNAPSHOT_KEY, info);
    return info;
  }

  private async profile(): Promise<{ size: number; at: string } | null> {
    const head = await this.env.ARTIFACTS.head(profileKey(this.agentId())).catch(() => null);
    return head ? { size: head.size, at: head.uploaded.toISOString() } : null;
  }

  async status() {
    const [config, settings, snapshot, started, running, profile] = await Promise.all([
      this.config(),
      getOrchestratorSettings(this.env.DB_CORE),
      this.ctx.storage.get<SnapshotInfo>(SNAPSHOT_KEY),
      this.ctx.storage.get<StartedInfo>(STARTED_KEY),
      this.runningInTier(),
      this.profile(),
    ]);
    const isRunning = Boolean(this.container?.running);
    const image = isRunning && started ? started.image : config.container_image;
    return {
      agent_id: this.agentId(),
      enabled: config.sandbox_enabled,
      global: config.sandbox_global,
      active: config.sandbox_active,
      running: isRunning,
      started_at: isRunning ? (started?.at ?? null) : null,
      // A running container keeps the settings it started with.
      internet: isRunning && started ? started.internet : config.sandbox_internet,
      persist: config.sandbox_persist,
      image,
      instance: isRunning && started ? started.instance : config.container_instance,
      desktop: imageInfo(image).desktop,
      snapshot: snapshot && (snapshot.image ?? "debian") === config.container_image ? snapshot : null,
      profile,
      tier: { running: running + (isRunning ? 1 : 0), max: settings[MAX_KEY[this.tier()]] },
      idle_timeout_min: INACTIVITY_TIMEOUT_MS / 60_000,
      command_timeout_s: COMMAND_TIMEOUT_S,
    };
  }

  // Stop (kill) the container: save the browser profile (desktop) and, with persist on, the
  // files first. The next command starts it again with the current settings.
  async stop() {
    const container = this.container;
    if (container?.running) {
      const config = await this.config();
      const started = await this.ctx.storage.get<StartedInfo>(STARTED_KEY);
      const image = started?.image ?? config.container_image;
      if (imageInfo(image).desktop) {
        await this.exec("profile-sync.sh push", 60).catch((err) => console.error("profile push failed", err));
      }
      if (config.sandbox_persist) await this.snapshot(image).catch((err) => console.error("sandbox snapshot failed", err));
      await container.destroy();
    }
    await this.markStopped();
    return this.status();
  }

  // Kept for the 013 Config button name.
  restart() {
    return this.stop();
  }

  // Stop the container and drop the stored snapshot: the next command starts clean from the image.
  async reset() {
    const container = this.container;
    if (container?.running) await container.destroy();
    await this.ctx.storage.delete(SNAPSHOT_KEY);
    await this.markStopped();
    return this.status();
  }

  // Delete the saved browser profile (R2). The running browser keeps its state until the next start.
  async resetProfile() {
    await this.env.ARTIFACTS.delete(profileKey(this.agentId()));
    return this.status();
  }

  // Image or instance changed: restart so the next start uses them. A snapshot of another image
  // can't be restored, so it's dropped.
  async changed(imageChanged: boolean) {
    if (imageChanged) {
      if (this.container?.running) await this.container.destroy();
      await this.ctx.storage.delete(SNAPSHOT_KEY);
      await this.markStopped();
      return this.status();
    }
    return this.stop();
  }

  // /container/<agent-id>/view/* -> noVNC (websockify on 6080), same origin as the UI.
  async view(request: Request, subpath: string): Promise<Response> {
    const config = await this.config();
    const container = this.container;
    const startButton = `<button onclick="this.disabled=true;this.textContent='Starting…';fetch('/api/containers/${this.agentId()}/start',{method:'POST'}).then(r=>r.json()).then(d=>{if(!d.ok){document.body.innerText=d.error||'Could not start.';return}setTimeout(()=>location.reload(),4000)})">Start</button>`;
    if (!config.sandbox_enabled) return page("No container", "This agent has no container.");
    if (!imageInfo(config.container_image).desktop) return page("No desktop", `Image <b>${config.container_image}</b> has no desktop to show.`);
    if (!container?.running) return page("Stopped", `The container is stopped.<br>${startButton}`);
    const url = new URL(request.url);
    try {
      const res = await container.getTcpPort(NOVNC_PORT).fetch(new Request(`http://container${subpath}${url.search}`, request));
      await this.markUsed();
      return res;
    } catch {
      // websockify takes a few seconds after the container starts.
      return page("Starting", `The desktop is starting…<script>setTimeout(()=>location.reload(),3000)</script>`);
    }
  }
}
