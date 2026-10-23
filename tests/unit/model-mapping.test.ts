import assert from "node:assert/strict";
import test from "node:test";

import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

import { toProviderModel } from "../../src/model-mapping.js";
import { parseModelCatalog, type ZenMuxModel } from "../../src/zenmux-api.js";

function map(model: ZenMuxModel) {
  const mapped = toProviderModel(model);
  assert.ok(mapped);
  return mapped;
}

function usage(input: number): Usage {
  return {
    input,
    output: 1_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("toProviderModel filters unsupported API entries", () => {
  assert.equal(toProviderModel({ id: "image", model_type: "image" }), null);
  assert.equal(
    toProviderModel({ id: "anthropic-only", endpoints: ["anthropic"] }),
    null,
  );
});

test("toProviderModel maps defaults, vision, names, and output bounds", () => {
  const defaults = map({ id: "plain" });
  assert.equal(defaults.name, "plain");
  assert.equal(defaults.contextWindow, 128_000);
  assert.equal(defaults.maxTokens, 4_096);
  assert.deepEqual(defaults.input, ["text"]);

  const vision = map({
    id: "vision",
    display_name: "Vision",
    context_size: 4_000,
    max_output_tokens: 8_000,
    input_modalities: ["text", "image"],
  });
  assert.equal(vision.name, "Vision");
  assert.equal(vision.maxTokens, 4_000);
  assert.deepEqual(vision.input, ["text", "image"]);
});

test("compatibility flags match ZenMux Chat Completions semantics", () => {
  const plain = map({ id: "plain" });
  assert.deepEqual(plain.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_completion_tokens",
    supportsUsageInStreaming: true,
    supportsStore: false,
    supportsStrictMode: true,
  });

  const reasoning = map({ id: "reasoning", features: ["reasoning"] });
  assert.equal(reasoning.reasoning, true);
  assert.equal(reasoning.compat.thinkingFormat, undefined);
  assert.equal(reasoning.compat.supportsReasoningEffort, true);
  assert.equal(reasoning.compat.requiresReasoningContentOnAssistantMessages, undefined);
  assert.equal(reasoning.thinkingLevelMap?.minimal, "minimal");
  assert.equal(reasoning.thinkingLevelMap?.high, "high");
});

test("flat and cache pricing convert ZenMux units to USD per million tokens", () => {
  const flat = map({
    id: "flat",
    input_token_price_per_m: 2690,
    output_token_price_per_m: 3400,
  });
  assert.deepEqual(flat.cost, {
    input: 0.269,
    output: 0.34,
    cacheRead: 0,
    cacheWrite: 0,
  });

  const rich = map({
    id: "rich",
    pricing: {
      prompt: { price_per_m: 10_000 },
      completion: { price_per_m: 20_000 },
      input_cache_read: { price_per_m: 1_000 },
    },
  });
  assert.deepEqual(rich.cost, {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0,
  });

  assert.deepEqual(map({ id: "zero", input_token_price_per_m: 0 }).cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(map({ id: "missing-price" }).cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("tier boundaries activate at ZenMux's inclusive min_tokens value", () => {
  const mapped = map({
    id: "tiered",
    tiered_billing_configs: [
      {
        min_tokens: 1,
        max_tokens: 524_288,
        pricing: {
          prompt: { price_per_m: 10_000 },
          completion: { price_per_m: 20_000 },
        },
      },
      {
        min_tokens: 524_288,
        max_tokens: 1_000_000,
        pricing: {
          prompt: { price_per_m: 30_000 },
          completion: { price_per_m: 40_000 },
        },
      },
    ],
  });
  assert.equal(mapped.cost.tiers?.[0]?.inputTokensAbove, 524_287);

  const model = mapped as unknown as Model<"openai-completions">;
  assert.equal(calculateCost(model, usage(524_287)).input, 0.524287);
  assert.equal(calculateCost(model, usage(524_288)).input, 1.572864);
});

function conditioned(value: number, bound: Record<string, string | number>, unit = "kTokens") {
  return { value, unit: "perMTokens", conditions: { prompt_tokens: { unit, ...bound } } };
}

function mapLive(id: string, pricings: Record<string, unknown>) {
  const parsed = parseModelCatalog({ data: [{ id, pricings }] });
  assert.ok(parsed?.models[0]);
  return map(parsed.models[0]);
}

test("conditioned prompt-length pricing becomes cost tiers (claude-haiku-5.5 shape)", () => {
  const mapped = mapLive("anthropic/claude-haiku-5.5", {
    prompt: [conditioned(0.1, { gte: "0" }), conditioned(0.5, { gte: "100" })],
    completion: [conditioned(0.5, { gte: "0" }), conditioned(2.5, { gte: "100" })],
    input_cache_read: [conditioned(0.01, { gte: "0" }), conditioned(0.05, { gte: "100" })],
  });
  assert.deepEqual(mapped.cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0,
    tiers: [
      { inputTokensAbove: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
    ],
  });
  const model = mapped as unknown as Model<"openai-completions">;
  assert.equal(calculateCost(model, usage(99_999)).input, 0.0099999);
  assert.ok(Math.abs(calculateCost(model, usage(100_000)).input - 0.05) < 1e-12);
});

test("gt bounds, token units, and missing tier categories fall back to base rates", () => {
  const mapped = mapLive("vendor/gt", {
    prompt: [conditioned(1, {}, "tokens"), conditioned(2, { gt: 200_000 }, "tokens")],
    completion: [conditioned(3, { gte: 0 }, "tokens")],
  });
  assert.deepEqual(mapped.cost, {
    input: 1,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 200_000, input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }],
  });
});

test("unknown condition units and unconditioned arrays keep first-entry pricing", () => {
  const unknownUnit = mapLive("vendor/unit", {
    prompt: [conditioned(1, { gte: 0 }, "mTokens"), conditioned(2, { gte: 1 }, "mTokens")],
  });
  assert.deepEqual(unknownUnit.cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });

  const plain = mapLive("deepseek/deepseek-v4-pro", {
    prompt: [{ value: 0.2, unit: "perMTokens" }, { value: 0.4, unit: "perMTokens" }],
    completion: [{ value: 0.6, unit: "perMTokens" }, { value: 1.2, unit: "perMTokens" }],
  });
  assert.deepEqual(plain.cost, { input: 0.2, output: 0.6, cacheRead: 0, cacheWrite: 0 });
});

test("live max_tokens flows into maxTokens", () => {
  const parsed = parseModelCatalog({
    data: [{ id: "vendor/big", context_length: 1_000_000, max_tokens: 512_000 }],
  });
  assert.equal(map(parsed!.models[0]!).maxTokens, 512_000);
});
