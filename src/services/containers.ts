// Container images and instance sizes per agent (task 014, SPEC-containers 0).
// One container per agent (its Durable Object's ctx.container); the agent picks the image.

import { ServiceError } from "./errors";

export const INSTANCE_TYPES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

// Stock registry image, not built by us (no entry in wrangler.jsonc images).
export const DEBIAN_IMAGE = "cloudflare/debian-trixie";

export interface ImageInfo {
  name: string;
  description: string;
  default_instance: InstanceType;
  desktop: boolean; // has the noVNC viewer on 6080 and the browser profile sync
}

const BUILTIN: Record<string, ImageInfo> = {
  debian: { name: "debian", description: "Debian with Node.js and npm", default_instance: "lite", desktop: false },
  desktop: {
    name: "desktop",
    description: "Minimal XFCE desktop with Chromium, noVNC and agent-browser",
    default_instance: "standard-1",
    desktop: true,
  },
};

const CUSTOM_DEFAULT_INSTANCE: InstanceType = "basic";

export function imageInfo(name: string): ImageInfo {
  return BUILTIN[name] ?? { name, description: `Custom image ${name}`, default_instance: CUSTOM_DEFAULT_INSTANCE, desktop: false };
}

// All images an agent can use: the stock one plus everything in wrangler.jsonc `images`.
export function imagesFrom(deployed: string[]): ImageInfo[] {
  return ["debian", ...deployed.filter((n) => n !== "debian")].map(imageInfo);
}

export function effectiveInstance(image: string, instance: string | null): InstanceType {
  return instance && (INSTANCE_TYPES as readonly string[]).includes(instance) ? (instance as InstanceType) : imageInfo(image).default_instance;
}

export function checkImageName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new ServiceError("invalid_input", `Invalid image ${name}`, "Use debian, desktop or a custom image name from wrangler.jsonc.");
  }
}

export function checkInstance(instance: string | null): void {
  if (instance !== null && !(INSTANCE_TYPES as readonly string[]).includes(instance)) {
    throw new ServiceError("invalid_input", `Unknown instance type ${instance}`, `Use one of: ${INSTANCE_TYPES.join(", ")}.`);
  }
}

// R2 key of an agent's saved browser profile (desktop images).
export function profileKey(agentId: string): string {
  return `agents/${agentId}/browser-profile.tar.gz`;
}

export const PROFILE_MAX_BYTES = 200 * 1024 * 1024;
