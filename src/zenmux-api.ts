import {
  BALANCE_URL,
  BASE_URL,
  MODELS_URL,
  REQUEST_TIMEOUT_MS,
} from "./config.js";

export const ZENMUX_FEATURES = [
  "serverless",
  "function-calling",
  "structured-outputs",
  "reasoning",
] as const;
export const ZENMUX_INPUT_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
] as const;
export const ZENMUX_OUTPUT_MODALITIES = ["text", "audio"] as const;

export type ZenMuxFeature = (typeof ZENMUX_FEATURES)[number];
export type ZenMuxInputModality = (typeof ZENMUX_INPUT_MODALITIES)[number];
export type ZenMuxOutputModality = (typeof ZENMUX_OUTPUT_MODALITIES)[number];

export interface ZenMuxModel {
  id: string;
  display_name?: string;
  context_length?: number;
  capabilities?: { reasoning?: boolean; function_calling?: boolean; structured_outputs?: boolean };
  input_modalities?: ZenMuxInputModality[];
  output_modalities?: ZenMuxOutputModality[];
  pricings?: ZenMuxPricing;
  // Legacy-compatible aliases retained for fallback fixtures and callers.
  context_size?: number;
  max_output_tokens?: number;
  features?: ZenMuxFeature[];
  model_type?: string;
  endpoints?: string[];
  input_token_price_per_m?: number;
  output_token_price_per_m?: number;
  pricing?: ZenMuxPricing;
  tiered_billing_configs?: ZenMuxBillingTier[];
}

export interface ZenMuxPricing {
  prompt?: ZenMuxPrice;
  completion?: ZenMuxPrice;
  input_cache_read?: ZenMuxPrice;
  input_cache_write?: ZenMuxPrice;
}

export interface ZenMuxPrice {
  value?: number;
  unit?: string;
  price_per_m?: number;
  conditions?: { prompt_tokens?: ZenMuxCondition };
}

export interface ZenMuxCondition { unit: string; gte?: number; gt?: number; lt?: number; lte?: number }

export interface ZenMuxBillingTier {
  min_tokens: number;
  max_tokens: number;
  pricing: ZenMuxPricing;
}

export interface CatalogParseResult {
  models: ZenMuxModel[];
  rejectedEntries: number;
  duplicateEntries: number;
}

export interface FetchModelsOptions {
  signal?: AbortSignal;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface ZenMuxError {
  code: number;
  reason: string;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: ZenMuxError;
  detail: string;
}

export type ApiKeyValidationStatus = "valid" | "invalid" | "indeterminate";

export interface ApiKeyValidationResult {
  status: ApiKeyValidationStatus;
  httpStatus?: number;
  error?: ZenMuxError;
  detail: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const AUTH_FAILURE_REASONS = new Set([
  "INVALID_API_KEY",
  "FAILED_TO_AUTH",
  "MISSING_API_KEY",
  "UNAUTHORIZED",
  "BILLING_AUTH_FAILED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): { valid: boolean; value?: number } {
  if (!(key in record)) return { valid: true };
  const value = nonNegativeNumber(record[key]);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return key in record ? positiveInteger(record[key]) : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function knownStringArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowedSet = new Set<string>(allowed);
  const values = value.filter(
    (entry): entry is T => typeof entry === "string" && allowedSet.has(entry),
  );
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 128);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function parsePrice(value: unknown): ZenMuxPrice | undefined {
  if (!isRecord(value)) return undefined;
  const price = nonNegativeNumber(value.value);
  const legacy = nonNegativeNumber(value.price_per_m);
  const unit = typeof value.unit === "string" ? value.unit : undefined;
  if (price === undefined && legacy === undefined) return undefined;
  const c = isRecord(value.conditions) && isRecord(value.conditions.prompt_tokens) ? value.conditions.prompt_tokens : undefined;
  const conditions = c ? { prompt_tokens: { unit: typeof c.unit === "string" ? c.unit : "kTokens", gte: nonNegativeNumber(c.gte), gt: nonNegativeNumber(c.gt), lt: nonNegativeNumber(c.lt), lte: nonNegativeNumber(c.lte) } } : undefined;
  return { ...(price !== undefined ? { value: price } : {}), ...(legacy !== undefined ? { price_per_m: legacy } : {}), ...(unit ? { unit } : {}), ...(conditions ? { conditions } : {}) };
}

function parsePricing(value: unknown): ZenMuxPricing | undefined {
  if (!isRecord(value)) return undefined;
  const pricing: ZenMuxPricing = {};
  const first = (v: unknown) => Array.isArray(v) ? v.map(parsePrice).find(Boolean) : parsePrice(v);
  const prompt = first(value.prompt);
  const completion = first(value.completion);
  const cacheRead = first(value.input_cache_read);
  const cacheWrite = first(value.input_cache_write);
  if (prompt) pricing.prompt = prompt;
  if (completion) pricing.completion = completion;
  if (cacheRead) pricing.input_cache_read = cacheRead;
  if (cacheWrite) pricing.input_cache_write = cacheWrite;
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function parseBillingTiers(value: unknown): ZenMuxBillingTier[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers: ZenMuxBillingTier[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const minTokens = positiveInteger(entry.min_tokens);
    const maxTokens = positiveInteger(entry.max_tokens);
    const pricing = parsePricing(entry.pricing);
    if (
      minTokens === undefined ||
      maxTokens === undefined ||
      maxTokens < minTokens ||
      !pricing
    ) {
      continue;
    }
    tiers.push({ min_tokens: minTokens, max_tokens: maxTokens, pricing });
  }

  tiers.sort(
    (left, right) =>
      left.min_tokens - right.min_tokens || left.max_tokens - right.max_tokens,
  );
  const deduplicated = tiers.filter(
    (tier, index) =>
      index === 0 || tier.min_tokens !== tiers[index - 1]?.min_tokens,
  );
  return deduplicated.length > 0 ? deduplicated : undefined;
}

function parseModel(value: unknown): ZenMuxModel | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value, "id");
  if (!id || !MODEL_ID_PATTERN.test(id)) return null;

  const model: ZenMuxModel = { id };
  const displayName = optionalString(value, "display_name");
  const contextSize = optionalPositiveInteger(value, "context_length");
  const legacyContext = optionalPositiveInteger(value, "context_size");
  const legacyMax = optionalPositiveInteger(value, "max_output_tokens");
  const legacyType = optionalString(value, "model_type");
  const legacyFeatures = knownStringArray(value.features, ZENMUX_FEATURES);
  const capabilities = isRecord(value.capabilities) ? { reasoning: value.capabilities.reasoning === true, function_calling: value.capabilities.function_calling === true, structured_outputs: value.capabilities.structured_outputs === true } : undefined;
  const legacyEndpoints = stringArray(value.endpoints);
  const legacyTiers = parseBillingTiers(value.tiered_billing_configs);
  const inputModalities = knownStringArray(
    value.input_modalities,
    ZENMUX_INPUT_MODALITIES,
  );
  const outputModalities = knownStringArray(
    value.output_modalities,
    ZENMUX_OUTPUT_MODALITIES,
  );
  const pricing = parsePricing(value.pricings ?? value.pricing);
  const legacyInput = optionalNumber(value, "input_token_price_per_m");
  const legacyOutput = optionalNumber(value, "output_token_price_per_m");
  if (!legacyInput.valid || !legacyOutput.valid) return null;

  if (displayName) model.display_name = displayName;
  if (contextSize !== undefined) { model.context_length = contextSize; model.context_size = contextSize; }
  if (legacyContext !== undefined) model.context_size = legacyContext;
  if (legacyMax !== undefined) model.max_output_tokens = legacyMax;
  if (legacyType) model.model_type = legacyType;
  if (legacyFeatures) model.features = legacyFeatures;
  if (capabilities) model.capabilities = capabilities;
  if (legacyEndpoints) model.endpoints = legacyEndpoints;
  if (legacyTiers) model.tiered_billing_configs = legacyTiers;
  if (inputModalities) model.input_modalities = inputModalities;
  if (outputModalities) model.output_modalities = outputModalities;
  if (pricing) { if (value.pricings !== undefined) model.pricings = pricing; model.pricing = pricing; }
  if (legacyInput.value !== undefined) model.input_token_price_per_m = legacyInput.value;
  if (legacyOutput.value !== undefined) model.output_token_price_per_m = legacyOutput.value;
  return model;
}

/** Validate a /v1/models payload without trusting any JSON shape. */
export function parseModelCatalog(payload: unknown): CatalogParseResult | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const models: ZenMuxModel[] = [];
  const seen = new Set<string>();
  let rejectedEntries = 0;
  let duplicateEntries = 0;
  for (const entry of payload.data) {
    const model = parseModel(entry);
    if (!model) {
      rejectedEntries += 1;
      continue;
    }
    if (seen.has(model.id)) {
      duplicateEntries += 1;
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return { models, rejectedEntries, duplicateEntries };
}

/** Fetch and validate the live model catalog. Returns null on any failure. */
export async function fetchModels(
  options: FetchModelsOptions = {},
): Promise<CatalogParseResult | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  try {
    const response = await fetchImpl(MODELS_URL, {
      headers,
      signal: options.signal,
    });
    if (!response.ok) return null;
    const parsed = parseModelCatalog((await response.json()) as unknown);
    return parsed && parsed.models.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function parseZenMuxError(body: string): ZenMuxError | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return null;
    const code = parsed.code;
    const reason = parsed.reason;
    const message = parsed.message;
    if (
      Number.isInteger(code) &&
      typeof reason === "string" &&
      reason.length > 0 &&
      typeof message === "string" &&
      message.length > 0
    ) {
      return { code: code as number, reason, message };
    }
  } catch {
    // Plain-text provider errors are handled by the caller.
  }
  return null;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function safeBodyDetail(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 200) : "empty response body";
}

/** Run a minimal model-specific completion for the /zenmux diagnostic. */
export async function probeChatCompletion(
  apiKey: string,
  model: string,
  options: RequestOptions = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = requestSignal(options.signal);
  try {
    const response = await fetchImpl(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
      }),
      signal,
    });
    const body = await response.text();
    if (response.ok) {
      try {
        const payload = JSON.parse(body) as unknown;
        if (!isRecord(payload) || !Array.isArray(payload.choices)) {
          return {
            ok: false,
            status: response.status,
            detail: `${model}: ZenMux returned malformed completion JSON`,
          };
        }
      } catch {
        return {
          ok: false,
          status: response.status,
          detail: `${model}: ZenMux returned invalid completion JSON`,
        };
      }
      return {
        ok: true,
        status: response.status,
        detail: `${model}: completion probe succeeded`,
      };
    }

    const error = parseZenMuxError(body);
    return {
      ok: false,
      status: response.status,
      error: error ?? undefined,
      detail: error
        ? `${model}: HTTP ${response.status} ${error.reason}: ${error.message}`
        : `${model}: HTTP ${response.status}: ${safeBodyDetail(body)}`,
    };
  } catch (error) {
    const detail = isAbortError(error, signal)
      ? "request timed out or was aborted"
      : "network request failed";
    return { ok: false, detail: `${model}: ${detail}` };
  }
}

function hasCatalogShape(payload: unknown): boolean {
  const parsed = parseModelCatalog(payload);
  if (parsed && parsed.models.length > 0) return true;
  if (isRecord(payload) && typeof payload.availableBalance === "string") return /^-?\d+$/.test(payload.availableBalance);
  return false;
}

export function isAuthenticationFailure(
  status: number,
  error: ZenMuxError | null,
): boolean {
  return status === 401 || Boolean(error && AUTH_FAILURE_REASONS.has(error.reason));
}

/** Validate a key without consuming model tokens. */
export async function validateApiKey(
  apiKey: string,
  options: RequestOptions = {},
): Promise<ApiKeyValidationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = requestSignal(options.signal);
  try {
    const response = await fetchImpl(BALANCE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
    });
    const body = await response.text();
    const error = parseZenMuxError(body);

    if (response.ok) {
      try {
        if (hasCatalogShape(JSON.parse(body) as unknown)) {
          return {
            status: "valid",
            httpStatus: response.status,
            detail: "ZenMux accepted the key",
          };
        }
      } catch {
        // Report malformed success responses as indeterminate below.
      }
      return {
        status: "indeterminate",
        httpStatus: response.status,
        detail: "ZenMux returned a malformed balance response",
      };
    }

    if (isAuthenticationFailure(response.status, error)) {
      return {
        status: "invalid",
        httpStatus: response.status,
        error: error ?? undefined,
        detail: error?.message ?? "ZenMux rejected the API key",
      };
    }

    return {
      status: "indeterminate",
      httpStatus: response.status,
      error: error ?? undefined,
      detail: error
        ? `${error.reason}: ${error.message}`
        : `HTTP ${response.status}: ${safeBodyDetail(body)}`,
    };
  } catch (error) {
    const detail = isAbortError(error, signal)
      ? "validation timed out or was aborted"
      : "validation request failed";
    return { status: "indeterminate", detail };
  }
}
