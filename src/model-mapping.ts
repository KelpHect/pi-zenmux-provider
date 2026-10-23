import {
  ZENMUX_PRICE_CATEGORIES,
  type ZenMuxBillingTier,
  type ZenMuxModel,
  type ZenMuxPrice,
  type ZenMuxPriceCategory,
  type ZenMuxPricing,
} from "./zenmux-api.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "./config.js";

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ModelCost extends ModelCostRates {
  tiers?: (ModelCostRates & { inputTokensAbove: number })[];
}

export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "qwen";
}

export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >;
  compat: OpenAICompletionsCompat;
}

// ZenMux's API accepts OpenAI Chat Completions requests with these deviations
// (all verified against https://zenmux.ai/docs/api/openai/create-chat-completion.html):
// - "system" role: the docs now also list a "developer" message, but
//   "system" stays the portable choice across ZenMux's routed upstreams
// - `max_completion_tokens`; `max_tokens` is listed under "Unsupported fields"
//   ("Deprecated; replaced by max_completion_tokens", re-checked 2026-10-22)
// - no Responses-API `store` parameter
// - usage is present in streaming responses via stream_options.include_usage
// Explicit compat matters: Pi's auto-detection assumes OpenAI defaults for
// unknown base URLs (developer role, store).
const BASE_COMPAT: OpenAICompletionsCompat = {
  supportsDeveloperRole: false,
  maxTokensField: "max_completion_tokens",
  supportsUsageInStreaming: true,
  supportsStore: false,
  supportsStrictMode: true,
};

const REASONING_COMPAT: OpenAICompletionsCompat = {
  ...BASE_COMPAT,
  supportsReasoningEffort: true,
};

const REASONING_LEVELS: ProviderModel["thinkingLevelMap"] = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

// ZenMux prices are USD per million tokens in units of $0.0001
// (input_token_price_per_m: 2690 = $0.269/M).
const PRICE_UNITS_PER_USD = 10000;

/**
 * Maps a ZenMux /v1/models entry to a Pi model config, or null for entries
 * Pi cannot serve (non-chat model types, no chat/completions endpoint).
 */
export function toProviderModel(model: ZenMuxModel): ProviderModel | null {
  if (model.model_type && model.model_type !== "chat") return null;
  if (model.endpoints && !model.endpoints.includes("chat/completions")) {
    return null;
  }

  const reasoning = model.capabilities?.reasoning ?? model.features?.includes("reasoning") ?? false;
  const contextWindow = model.context_length ?? model.context_size ?? DEFAULT_CONTEXT_WINDOW;
  const advertisedMax = model.max_output_tokens ?? DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(advertisedMax, contextWindow);

  return {
    id: model.id,
    name: model.display_name || model.id,
    reasoning,
    input: model.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
    cost: toCost(model),
    contextWindow,
    maxTokens,
    ...(reasoning ? { thinkingLevelMap: REASONING_LEVELS } : {}),
    compat: reasoning ? REASONING_COMPAT : BASE_COMPAT,
  };
}
function toCost(model: ZenMuxModel): ModelCost {
  const tiers = model.tiered_billing_configs;
  if (tiers && tiers.length > 0) {
    const [first, ...rest] = tiers as [
      ZenMuxBillingTier,
      ...ZenMuxBillingTier[],
    ];
    const firstIsBase = first.min_tokens <= 1;
    const baseRates = firstIsBase ? ratesFromPricing(first.pricing) : flatCost(model);
    const alternateTiers = firstIsBase ? rest : tiers;
    return {
      ...baseRates,
      tiers: alternateTiers.map((tier) => ({
        // Pi activates a tier when input is strictly greater than this value.
        // ZenMux names the lower boundary min_tokens, so subtract one to make
        // the tier active at that inclusive boundary.
        inputTokensAbove: Math.max(0, tier.min_tokens - 1),
        ...ratesFromPricing(tier.pricing),
      })),
    };
  }

  const pricing = model.pricings ?? model.pricing;
  if (pricing) return costFromPricing(pricing);

  return flatCost(model);
}

const PROMPT_UNIT_TOKENS: Record<string, number> = { kTokens: 1000, tokens: 1 };

interface CategoryTiers {
  base?: ZenMuxPrice;
  above: Map<number, ZenMuxPrice>;
}

/** Splits one category's conditioned entries; null when a unit is unknown. */
function splitCategoryTiers(entries: ZenMuxPrice[]): CategoryTiers | null {
  const result: CategoryTiers = { above: new Map() };
  for (const entry of entries) {
    const condition = entry.conditions?.prompt_tokens;
    if (!condition) {
      result.base ??= entry;
      continue;
    }
    const unitTokens = PROMPT_UNIT_TOKENS[condition.unit];
    if (unitTokens === undefined) return null;
    const isGt = condition.gte === undefined && condition.gt !== undefined;
    const lower = condition.gte ?? condition.gt;
    const lowerTokens = lower === undefined ? 0 : lower * unitTokens;
    if (!isGt && lowerTokens <= 0) {
      result.base ??= entry;
      continue;
    }
    const above = isGt ? lowerTokens : lowerTokens - 1;
    if (!result.above.has(above)) result.above.set(above, entry);
  }
  return result;
}

function costFromPricing(pricing: ZenMuxPricing): ModelCost {
  const baseRates = ratesFromPricing(pricing);
  if (!pricing.tiers) return baseRates;

  const split = new Map<ZenMuxPriceCategory, CategoryTiers>();
  for (const category of ZENMUX_PRICE_CATEGORIES) {
    const entries = pricing.tiers[category];
    if (!entries) continue;
    const categoryTiers = splitCategoryTiers(entries);
    if (!categoryTiers) return baseRates;
    split.set(category, categoryTiers);
  }

  const baseOf = (category: ZenMuxPriceCategory): ZenMuxPrice | undefined =>
    split.get(category)?.base ?? pricing[category];
  const ratesAt = (pick: (category: ZenMuxPriceCategory) => ZenMuxPrice | undefined) => {
    const picked: ZenMuxPricing = {};
    for (const category of ZENMUX_PRICE_CATEGORIES) {
      const price = pick(category);
      if (price) picked[category] = price;
    }
    return ratesFromPricing(picked);
  };

  const boundaries = new Set<number>();
  for (const categoryTiers of split.values()) {
    for (const above of categoryTiers.above.keys()) boundaries.add(above);
  }
  if (boundaries.size === 0) return ratesAt(baseOf);

  return {
    ...ratesAt(baseOf),
    tiers: [...boundaries]
      .sort((left, right) => left - right)
      .map((above) => ({
        inputTokensAbove: Math.max(0, above),
        ...ratesAt((category) => split.get(category)?.above.get(above) ?? baseOf(category)),
      })),
  };
}

function flatCost(model: ZenMuxModel): ModelCostRates {
  return {
    input: (model.input_token_price_per_m ?? 0) / PRICE_UNITS_PER_USD,
    output: (model.output_token_price_per_m ?? 0) / PRICE_UNITS_PER_USD,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function ratesFromPricing(pricing: ZenMuxPricing): ModelCostRates {
  return {
    input: pricing.prompt?.value ?? ((pricing.prompt?.price_per_m ?? 0) / PRICE_UNITS_PER_USD),
    output: pricing.completion?.value ?? ((pricing.completion?.price_per_m ?? 0) / PRICE_UNITS_PER_USD),
    // Caching is implicit on ZenMux (no cache_control params) and writes are
    // not billed separately on non-tiered models.
    cacheRead: pricing.input_cache_read?.value ?? ((pricing.input_cache_read?.price_per_m ?? 0) / PRICE_UNITS_PER_USD),
    cacheWrite: pricing.input_cache_write?.value ?? ((pricing.input_cache_write?.price_per_m ?? 0) / PRICE_UNITS_PER_USD),
  };
}
