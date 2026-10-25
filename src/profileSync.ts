// Browser profile sync for desktop containers (task 014, SPEC-containers 0).
// The container talks to http://flaretown.internal/profile; the agent intercepts that host and
// sends it here with props.agentId, so each container reads and writes only its own R2 key and
// no R2 credentials live in the container.

import { WorkerEntrypoint } from "cloudflare:workers";
import { PROFILE_MAX_BYTES, profileKey } from "./services/containers";

export class ProfileSync extends WorkerEntrypoint<Env, { agentId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/profile") return new Response("Not found", { status: 404 });
    const agentId = this.ctx.props?.agentId;
    if (!agentId) return new Response("No agent", { status: 403 });
    const key = profileKey(agentId);

    if (request.method === "GET") {
      const obj = await this.env.ARTIFACTS.get(key);
      return obj ? new Response(obj.body, { headers: { "content-type": "application/gzip" } }) : new Response("No profile", { status: 404 });
    }
    if (request.method === "PUT") {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > PROFILE_MAX_BYTES) return new Response("Profile over 200 MB", { status: 413 });
      const body = await request.arrayBuffer();
      if (body.byteLength > PROFILE_MAX_BYTES) return new Response("Profile over 200 MB", { status: 413 });
      await this.env.ARTIFACTS.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
      return new Response("saved");
    }
    return new Response("Method not allowed", { status: 405 });
  }
}
