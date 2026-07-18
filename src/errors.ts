import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KEY_MANAGEMENT_URL, PROVIDER_ID } from "./config.js";
import { parseZenMuxError } from "./zenmux-api.js";

// Documented at https://zenmux.ai/docs/api-reference/basic-error-code.
const GUIDANCE: Record<string, string> = {
  INVALID_API_KEY: `No valid API key was sent. Run /login and select "ZenMux AI", or check /zenmux. Keys: ${KEY_MANAGEMENT_URL}`,
  FAILED_TO_AUTH: `The API key was rejected. Re-run /login with a fresh key from ${KEY_MANAGEMENT_URL}`,
  NOT_ENOUGH_BALANCE:
    "Your ZenMux account balance is empty. Top up or redeem credits at https://zenmux.ai/billing",
  MODEL_NOT_FOUND: "This model id is not available on ZenMux. Pick another with /model",
  INVALID_REQUEST_BODY: "The request was rejected. Reduce the context or report a compatibility issue if the request is otherwise valid",
  RATE_LIMIT_EXCEEDED: "ZenMux rate limit hit. Retry shortly, or raise limits at https://zenmux.ai/quota-limits/llm",
  TOKEN_LIMIT_EXCEEDED: "ZenMux token-throughput limit hit. Retry shortly, or raise limits at https://zenmux.ai/quota-limits/llm",
  SERVICE_NOT_AVAILABLE: "ZenMux reports the service is temporarily unavailable. Retry shortly",
  ACCESS_DENY: "ZenMux denied access to this model or endpoint for your account",
};

// Pi triggers auto-compaction + retry when an error message contains this
// marker. ZenMux normally absorbs overflow by lowering max_tokens, but
// INVALID_REQUEST_BODY responses can still carry overflow phrasing.
const OVERFLOW_MARKER = "context_length_exceeded";
const OVERFLOW_PATTERN =
  /context\s*(length|window|limit)|input\s*length\s*exceed|exceeds?\s*(?:the\s*)?context|too\s*many\s*tokens|maximum\s*context/i;

/**
 * Pi surfaces provider failures as "<status>: <body>". ZenMux's body is
 * {code, reason, message}. This handler decodes it into an actionable
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
