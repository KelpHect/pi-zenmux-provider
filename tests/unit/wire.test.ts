import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import type { Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

import { decodeErrorMessage } from "../../src/errors.js";
import { toProviderModel } from "../../src/model-mapping.js";
import type { ZenMuxModel } from "../../src/zenmux-api.js";

interface Reply {
  status: number;
  body: string;
}

let server: Server;
let baseUrl = "";
let bodies: Record<string, unknown>[] = [];
let reply: Reply | null = null;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
      if (reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null, extra = {}) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "ok" }, null));
      res.write(
        chunk({}, "stop", {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function wireModel(id: string, reasoning = true): Model<"openai-completions"> {
  const model: ZenMuxModel = { id, capabilities: { reasoning } };
  const mapped = toProviderModel(model);
  assert.ok(mapped);
  return {
    ...mapped,
    api: "openai-completions",
    provider: "zenmux",
    baseUrl,
  } as Model<"openai-completions">;
}

const context: Context = {
  systemPrompt: "be brief",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

async function captureBody(
  id: string,
  reasoning?: ThinkingLevel,
  isReasoningModel = true,
): Promise<Record<string, unknown>> {
  bodies = [];
  reply = null;
  const result = await streamSimple(wireModel(id, isReasoningModel), context, {
    apiKey: "test",
    reasoning,
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(bodies.length, 1);
  return bodies[0]!;
}

async function errorMessageFor(status: number, body: string): Promise<string> {
  bodies = [];
  reply = { status, body };
  const result = await streamSimple(wireModel("anthropic/claude-sonnet-5"), context, {
    apiKey: "test",
    maxRetries: 0,
  }).result();
  reply = null;
  assert.equal(result.stopReason, "error");
  return result.errorMessage ?? "";
}

test("requests use max_completion_tokens and the system role", async () => {
  const body = await captureBody("openai/gpt-5.6-luna", undefined, false);
  assert.ok("max_completion_tokens" in body);
  assert.ok(!("max_tokens" in body));
  assert.ok(!("store" in body));
  const messages = body.messages as { role: string; content: unknown }[];
  assert.equal(messages[0]?.role, "system");
  assert.ok(!messages.some((message) => message.role === "developer"));
});

test("reasoning models send reasoning_effort high, or none when off", async () => {
  const on = await captureBody("anthropic/claude-sonnet-5", "high");
  assert.equal(on.reasoning_effort, "high");
  const off = await captureBody("anthropic/claude-sonnet-5");
  assert.equal(off.reasoning_effort, "none");
});

test("pi 1.x surfaces the inner error object and the decoder rewrites it", async () => {
  const guidance402 =
    "ZenMux requires positive credits for this model. Top up at https://zenmux.ai/platform/pay-as-you-go";
  const cases = [
    {
      name: "wrapped reject_no_credit",
      status: 402,
      body: JSON.stringify({
        error: { code: "402", type: "reject_no_credit", message: "Insufficient balance" },
      }),
      errorMessage:
        '402: {"code":"402","type":"reject_no_credit","message":"Insufficient balance"}',
      decoded: `ZenMux reject_no_credit (HTTP 402): Insufficient balance. ${guidance402}`,
    },
    {
      name: "legacy shape",
      status: 403,
      body: JSON.stringify({ code: 403, reason: "FAILED_TO_AUTH", message: "bad key" }),
      errorMessage: '403: {"code":403,"reason":"FAILED_TO_AUTH","message":"bad key"}',
      decoded:
        "ZenMux FAILED_TO_AUTH (HTTP 403): bad key. The API key was rejected. Re-run /login with a fresh key from https://zenmux.ai/platform/pay-as-you-go",
    },
    {
      name: "413 invalid_params",
      status: 413,
      body: JSON.stringify({
        error: { code: "413", type: "invalid_params", message: "Prompt too long" },
      }),
      errorMessage:
        '413: {"code":"413","type":"invalid_params","message":"Prompt too long"}',
      decoded:
        'context_length_exceeded: 413: {"code":"413","type":"invalid_params","message":"Prompt too long"}',
    },
    {
      name: "empty body",
      status: 400,
      body: "",
      errorMessage: "400 status code (no body)",
      decoded:
        "ZenMux returned HTTP 400 without a readable error body. Check that the model supports the request parameters and fits the context size. If it keeps failing, report it to ZenMux.",
    },
  ];
  for (const { name, status, body, errorMessage, decoded } of cases) {
    const observed = await errorMessageFor(status, body);
    assert.equal(observed, errorMessage, name);
    assert.equal(decodeErrorMessage(observed), decoded, name);
    assert.ok(!decoded.includes("you can retry your request"), name);
  }
});
