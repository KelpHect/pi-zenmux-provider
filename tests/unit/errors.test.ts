import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decodeErrorMessage, registerErrorDecoder } from "../../src/errors.js";

const documentedReasons = [
  "INVALID_API_KEY",
  "FAILED_TO_AUTH",
  "NOT_ENOUGH_BALANCE",
  "MODEL_NOT_FOUND",
  "INVALID_REQUEST_BODY",
  "RATE_LIMIT_EXCEEDED",
  "TOKEN_LIMIT_EXCEEDED",
  "SERVICE_NOT_AVAILABLE",
  "ACCESS_DENY",
] as const;

test("decodeErrorMessage adds actionable guidance for every documented LLM reason", () => {
  for (const reason of documentedReasons) {
    const decoded = decodeErrorMessage(
      `403: ${JSON.stringify({ code: 403, reason, message: "provider detail" })}`,
    );
    assert.match(decoded ?? "", new RegExp(reason));
    assert.match(decoded ?? "", /provider detail/);
    assert.ok((decoded?.length ?? 0) > "provider detail".length);
  }
});

test("decodeErrorMessage preserves unknown and plain errors safely", () => {
  assert.equal(decodeErrorMessage("502: plain gateway response"), null);
  assert.equal(
    decodeErrorMessage(
      '499: {"code":499,"reason":"NEW_REASON","message":"new detail"}',
    ),
    "ZenMux NEW_REASON (HTTP 499): new detail",
  );
});

test("decodeErrorMessage normalizes overflow exactly once", () => {
  assert.equal(
    decodeErrorMessage("400: maximum context length was exceeded"),
    "context_length_exceeded: 400: maximum context length was exceeded",
  );
  assert.equal(
    decodeErrorMessage("context_length_exceeded: already normalized"),
    null,
  );
});

const RETRY_MARKER = "you can retry your request";

test("decodeErrorMessage decodes the unwrapped inner error object", () => {
  assert.equal(
    decodeErrorMessage('429: {"code":"429","type":"rate_limit","message":"slow down"}'),
    "ZenMux rate_limit (HTTP 429): slow down. ZenMux rate limit hit. Retry shortly",
  );
});

test("decodeErrorMessage has guidance for the documented error types", () => {
  const types = [
    "quote_exceeded",
    "safety_check_failed",
    "provider_unprocessable_entity_error",
    "internal_server_error",
    "provider_api_error",
    "provider_error",
    "no_provider_available",
    "provider_internal_server_error",
  ];
  for (const type of types) {
    const decoded = decodeErrorMessage(
      JSON.stringify({ error: { code: "500", type, message: "detail" } }),
    );
    assert.ok(decoded?.startsWith(`ZenMux ${type} (HTTP 500): detail. `), type);
  }
});

test("413 invalid_params maps to the overflow marker", () => {
  const raw = '413: {"code":"413","type":"invalid_params","message":"Prompt too long"}';
  assert.equal(decodeErrorMessage(raw), `context_length_exceeded: ${raw}`);
  assert.equal(
    decodeErrorMessage("413 status code (no body)"),
    "context_length_exceeded: 413 status code (no body)",
  );
  assert.match(
    decodeErrorMessage('400: {"code":"400","type":"invalid_params","message":"bad"}') ?? "",
    /^ZenMux invalid_params \(HTTP 400\)/,
  );
});

test("bodyless failures get status-specific guidance", () => {
  assert.match(decodeErrorMessage("400 status code (no body)") ?? "", /HTTP 400 without a readable/);
  assert.match(decodeErrorMessage("401 status code (no body)") ?? "", /HTTP 401.*\/login.*\/zenmux/);
  assert.match(decodeErrorMessage("402 status code (no body)") ?? "", /HTTP 402.*balance/);
  assert.match(decodeErrorMessage("403 status code (no body)") ?? "", /HTTP 403.*\/zenmux/);
  assert.match(decodeErrorMessage("404 status code (no body)") ?? "", /HTTP 404.*\/model/);
  assert.match(decodeErrorMessage("429 status code (no body)") ?? "", /429/);
  assert.match(decodeErrorMessage("502 status code (no body)") ?? "", /502/);
  assert.match(decodeErrorMessage("524 status code (no body)") ?? "", /524/);
  assert.equal(decodeErrorMessage("418 status code (no body)"), null);
});

test("the pi auto-retry phrase never appears in ZenMux output", () => {
  const inputs = [
    ...[400, 401, 402, 403, 404, 413, 418, 429, 500, 502, 520, 524].map(
      (status) => `${status} status code (no body)`,
    ),
    '400: {"code":"400","type":"invalid_params","message":"invalid request error"}',
    '400: {"message":"invalid request error","type":"invalid_request_error"}',
    ...documentedReasons.map(
      (reason) => `400: ${JSON.stringify({ code: 400, reason, message: "m" })}`,
    ),
    ...[
      "quote_exceeded",
      "safety_check_failed",
      "provider_unprocessable_entity_error",
      "internal_server_error",
      "provider_api_error",
      "provider_error",
      "no_provider_available",
      "provider_internal_server_error",
      "rate_limit",
      "insufficient_credit",
      "reject_no_credit",
    ].map((type) => `500: ${JSON.stringify({ code: "500", type, message: "m" })}`),
  ];
  for (const input of inputs) {
    const decoded = decodeErrorMessage(input);
    assert.ok(!(decoded ?? "").includes(RETRY_MARKER), input);
  }
});

test("registered decoder changes ZenMux assistant errors only", () => {
  type Handler = (
    event: { message: Record<string, unknown> },
    context: { model?: { provider: string } },
  ) => unknown;
  let handler: Handler | undefined;
  const pi = {
    on: (event: string, value: Handler) => {
      assert.equal(event, "message_end");
      handler = value;
    },
  } as unknown as ExtensionAPI;
  registerErrorDecoder(pi);
  assert.ok(handler);

  const zenmux = handler(
    {
      message: {
        role: "assistant",
        provider: "zenmux",
        stopReason: "error",
        errorMessage:
          '403: {"code":403,"reason":"NOT_ENOUGH_BALANCE","message":"empty"}',
      },
    },
    {},
  ) as { message: { errorMessage: string } };
  assert.match(zenmux.message.errorMessage, /Top up/);

  assert.equal(
    handler(
      {
        message: {
          role: "assistant",
          provider: "other",
          stopReason: "error",
          errorMessage: "maximum context length",
        },
      },
      { model: { provider: "other" } },
    ),
    undefined,
  );
  assert.equal(
    handler(
      {
        message: {
          role: "assistant",
          provider: "other",
          stopReason: "error",
          errorMessage: "maximum context length",
        },
      },
      { model: { provider: "zenmux" } },
    ),
    undefined,
  );
});
