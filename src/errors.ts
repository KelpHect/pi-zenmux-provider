import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KEY_MANAGEMENT_URL, PROVIDER_ID } from "./config.js";
import { parseZenMuxError } from "./zenmux-api.js";

// Documented at https://zenmux.ai/docs/guide/advanced/error-codes.html.
const GUIDANCE: Record<string, string> = {
  INVALID_API_KEY: `No valid API key was sent. Run /login and select "ZenMux AI", or check /zenmux. Keys: ${KEY_MANAGEMENT_URL}`,
  FAILED_TO_AUTH: `The API key was rejected. Re-run /login with a fresh key from ${KEY_MANAGEMENT_URL}`,
  NOT_ENOUGH_BALANCE:
    "Your ZenMux account balance is empty. Top up or redeem credits at https://zenmux.ai/platform/pay-as-you-go",
  MODEL_NOT_FOUND: "This model id is not available on ZenMux. Pick another with /model",
  INVALID_REQUEST_BODY: "The request was rejected. Reduce the context or report a compatibility issue if the request is otherwise valid",
  RATE_LIMIT_EXCEEDED: "ZenMux rate limit hit. Retry shortly, or review your key limits at https://zenmux.ai/platform/pay-as-you-go",
  TOKEN_LIMIT_EXCEEDED: "ZenMux token-throughput limit hit. Retry shortly, or review your key limits at https://zenmux.ai/platform/pay-as-you-go",
  SERVICE_NOT_AVAILABLE: "ZenMux reports the service is temporarily unavailable. Retry shortly",
  ACCESS_DENY: "ZenMux denied access to this model or endpoint for your account",
  access_denied: `ZenMux denied access to this key or model. Check the key on ${KEY_MANAGEMENT_URL}`,
  reject_no_credit:
    "ZenMux requires positive credits for this model. Top up at https://zenmux.ai/platform/pay-as-you-go",
  insufficient_credit:
    "ZenMux reports an overdue or negative balance. Review the account at https://zenmux.ai/platform/pay-as-you-go",
  model_not_available:
    "This model is not included in the current subscription. Use a Pay As You Go key from https://zenmux.ai/platform/pay-as-you-go",
  invalid_model: "This model id is not available on ZenMux. Pick another with /model",
  model_not_supported:
    "This model does not support the selected API. Pick another model with /model",
  rate_limit: "ZenMux rate limit hit. Retry shortly",
  invalid_params:
    "ZenMux rejected the request parameters. Check the model capabilities and context size",
  quote_exceeded:
    "Your ZenMux subscription quota is used up. Wait for the quota to reset or switch to a Pay As You Go key from https://zenmux.ai/platform/pay-as-you-go",
  safety_check_failed:
    "ZenMux blocked the request in its safety check. Rephrase the input or pick another model with /model",
  provider_unprocessable_entity_error:
    "The upstream provider could not process the request. Check the model capabilities and parameters, or pick another model with /model",
  internal_server_error: "ZenMux hit an internal error. Retry shortly",
  provider_api_error: "The upstream provider returned an API error. Retry shortly or pick another model with /model",
  provider_error: "The upstream provider reported an error. Retry shortly or pick another model with /model",
  no_provider_available:
    "ZenMux has no provider available for this model right now. Retry shortly or pick another model with /model",
  provider_internal_server_error:
    "The upstream provider hit an internal error. Retry shortly or pick another model with /model",
};

// Pi triggers auto-compaction + retry when an error message contains this
// marker. ZenMux normally absorbs overflow by lowering max_tokens, but
// INVALID_REQUEST_BODY responses can still carry overflow phrasing.
const OVERFLOW_MARKER = "context_length_exceeded";
const OVERFLOW_PATTERN =
  /context\s*(length|window|limit)|input\s*length\s*exceed|exceeds?\s*(?:the\s*)?context|too\s*many\s*tokens|maximum\s*context/i;

/**
 * Pi surfaces provider failures as "<status>: <body>". ZenMux's body is
 * `{error:{code,type,message}}` body. Legacy `{code,reason,message}` bodies
 * are also accepted. This handler decodes it into an actionable
 * message and normalizes context-overflow errors so Pi can auto-compact.
 */
export function registerErrorDecoder(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const decoded = decodeErrorMessage(message.errorMessage ?? "");
    if (!decoded) return;
    return { message: { ...message, errorMessage: decoded } };
  });
}

const NO_BODY_PATTERN = /^(\d{3}) status code \(no body\)$/;
const STATUS_PREFIX_PATTERN = /^\d{3}:\s*/;
const PROMPT_TOO_LONG_STATUS = 413;

/** Returns the rewritten error message, or null to leave it unchanged. */
export function decodeErrorMessage(errorMessage: string): string | null {
  if (errorMessage.includes(OVERFLOW_MARKER)) return null;

  if (OVERFLOW_PATTERN.test(errorMessage)) {
    return `${OVERFLOW_MARKER}: ${errorMessage}`;
  }

  const noBody = NO_BODY_PATTERN.exec(errorMessage);
  if (noBody) return decodeNoBody(Number(noBody[1]), errorMessage);

  const body = errorMessage.replace(STATUS_PREFIX_PATTERN, "");
  const error = parseZenMuxError(body);
  if (!error) return null;

  if (error.code === PROMPT_TOO_LONG_STATUS && error.reason === "invalid_params") {
    return `${OVERFLOW_MARKER}: ${errorMessage}`;
  }

  const guidance = GUIDANCE[error.reason];
  return guidance
    ? `ZenMux ${error.reason} (HTTP ${error.code}): ${error.message}. ${guidance}`
    : `ZenMux ${error.reason} (HTTP ${error.code}): ${error.message}`;
}

function decodeNoBody(status: number, errorMessage: string): string | null {
  const prefix = `ZenMux returned HTTP ${status} without a readable error body.`;
  if (status === 400) {
    return `${prefix} Check that the model supports the request parameters and fits the context size. If it keeps failing, report it to ZenMux.`;
  }
  if (status === 401 || status === 403) {
    return `${prefix} The API key may be missing or rejected, or the account may lack access. Run /login to set a key and check /zenmux. Keys: ${KEY_MANAGEMENT_URL}`;
  }
  if (status === 402) {
    return `${prefix} The account balance may be empty. Top up at ${KEY_MANAGEMENT_URL} and check /zenmux`;
  }
  if (status === 404) {
    return `${prefix} The model id is probably not available on ZenMux. Pick another with /model`;
  }
  if (status === PROMPT_TOO_LONG_STATUS) {
    return `${OVERFLOW_MARKER}: ${errorMessage}`;
  }
  if (status === 429) {
    return `${prefix} ZenMux rate limit (HTTP 429). Retry shortly`;
  }
  if (status >= 500 && status <= 599) {
    return `${prefix} ZenMux reports a server error (HTTP ${status}). Retry shortly`;
  }
  return null;
}
