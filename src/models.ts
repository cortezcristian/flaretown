// Workers AI model ids (SPEC-models.md). The six main models offered in Config.
// contextWindow: known values from cloudflare-os' catalog; 131,072 is a conservative placeholder
// until checked against the Workers AI catalog.
export const MAIN_MODELS = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash", contextWindow: 131_072 },
  { id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_048_576 },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", contextWindow: 131_072 },
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (reasoning)", contextWindow: 131_072 },
  { id: "@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262_144 },
  { id: "@cf/zai-org/glm-5.2", name: "GLM 5.2 (reasoning)", contextWindow: 262_144 },
] as const;

export type ModelId = (typeof MAIN_MODELS)[number]["id"];

export function isMainModel(id: string): id is ModelId {
  return MAIN_MODELS.some((m) => m.id === id);
}

export function contextWindowOf(id: string): number {
  return MAIN_MODELS.find((m) => m.id === id)?.contextWindow ?? 131_072;
}

// Default for the Principal is GLM 5.2 (SPEC-models 1.1). Changeable per agent in Config.
export const PRINCIPAL_MODEL: ModelId = "@cf/zai-org/glm-5.2";

// Writes compaction summaries (cheap, large context).
export const SUMMARY_MODEL: ModelId = "@cf/zai-org/glm-5.3-flash";

// Compaction defaults (SPEC-agents section 9).
export const COMPACT_DEFAULT_RATIO = 0.7;
export const COMPACT_MAX_RATIO = 0.9;
export const COMPACT_MIN_TOKENS = 30_000;
export const KEEP_RECENT_TOKENS = 20_000;

export function defaultCompactAfter(modelId: string): number {
  return Math.floor(contextWindowOf(modelId) * COMPACT_DEFAULT_RATIO);
}
