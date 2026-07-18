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

/** Returns the rewritten error message, or null to leave it unchanged. */
export function decodeErrorMessage(errorMessage: string): string | null {
  if (errorMessage.includes(OVERFLOW_MARKER)) return null;

  if (OVERFLOW_PATTERN.test(errorMessage)) {
    return `${OVERFLOW_MARKER}: ${errorMessage}`;
  }

  const body = errorMessage.replace(/^\d{3}:\s*/, "");
  const error = parseZenMuxError(body);
  if (!error) return null;

  const guidance = GUIDANCE[error.reason];
  return guidance
    ? `ZenMux ${error.reason} (HTTP ${error.code}): ${error.message}. ${guidance}`
    : `ZenMux ${error.reason} (HTTP ${error.code}): ${error.message}`;
}
