# pi-zenmux-provider

Pi extension for using ZenMux models through ZenMux's OpenAI-compatible API.

The extension discovers the current ZenMux model catalog at startup, registers
the models that Pi can use, and keeps a small offline catalog for unavailable
or deliberately disabled network access.

## Requirements

- Node.js 22.19 or newer
- Pi 0.80.7 or newer
- A ZenMux API key

## Install

After the package is published:

```bash
pi install npm:pi-zenmux-provider
```

For a project-local install:

```bash
pi install -l npm:pi-zenmux-provider
```

To try the package without installing it:

```bash
pi -e npm:pi-zenmux-provider
```

## Configure

Run `/login` in Pi and choose **ZenMux AI**, then enter a key from the
[ZenMux API key page](https://zenmux.ai/platform/api-keys).

You can also provide the key through the environment:

```bash
export ZENMUX_API_KEY=your-key
```

PowerShell:

```powershell
$env:ZENMUX_API_KEY = "your-key"
```

Select a model with `/model`. ZenMux model IDs use the `provider/model` form,
such as `openai/gpt-5.6-terra`.

Use `/zenmux` to check credential resolution and send a one-token diagnostic
request. A model can be supplied explicitly:

```text
/zenmux openai/gpt-5.6-terra
```

## How it works

ZenMux exposes the OpenAI Chat Completions API at
`https://zenmux.ai/api/v1`. The extension uses Pi's built-in
`openai-completions` transport.

The published package has no runtime dependencies. Pi provides the two
`@earendil-works/pi-*` peer APIs through its extension loader, and Pi's package
manager disables peer auto-installation for managed extensions.

At startup it requests `GET /models`, validates the response, removes duplicate
or malformed entries, and registers chat-capable models. The catalog includes
context windows, input modalities, reasoning capability, and token prices.

If discovery fails, `PI_OFFLINE=1` is set, or no usable chat models are
returned, the bundled catalog in `src/fallback-models.ts` is used.

Refresh that catalog from the current ZenMux response with:

```bash
npm run catalog:refresh
```

ZenMux supports `reasoning_effort` for reasoning models. Pi's thinking levels
are mapped to the values supported by ZenMux. Tools, structured output, image
inputs, streaming, and usage reporting use the normal Chat Completions request
format.

## Development

Install dependencies and run the complete local gate:

```bash
npm ci
npm run verify
```

The verification gate runs TypeScript checking, unit tests, package-content
checks, packed-install checks, and a real Pi CLI model-listing smoke test.

Optional credentialed checks:

```bash
$env:ZENMUX_API_KEY = "your-key"
$env:ZENMUX_TEST_MODEL = "provider/chat-model"
npm run test:live
```

The live suite is skipped when `ZENMUX_API_KEY` is not set.

## Publishing

The package does not publish automatically. Before a release:

```bash
npm run verify
npm pack --dry-run
npm publish --access public
```

Review the generated package contents and confirm that the npm account is
logged in before publishing.

## Security

Pi extensions run with the user's permissions. This package sends prompts,
tool calls, and supported image inputs to ZenMux when a ZenMux model is used.
It does not include telemetry or store credentials outside Pi's credential
store and the `ZENMUX_API_KEY` environment variable.

## License

MIT
