# Evaluation Harness

This document covers the optional evaluation harness that sits on top of `AgentHarness`.

It is not the core SDK contract. The core package surface remains:

1. `AgentPayClient`
2. `preparePaidRequest(...)`
3. `executePreparedRequest(...)`
4. `fetchPaid(...)`

Use the harness when you want a preparedId-based tool surface for a model host, especially the repo-local OpenAI Responses example under `examples/openai-agent-harness.mjs`.

## Boundary

The boundary is:

1. core SDK: `AgentPayClient`, `preparePaidRequest(...)`, `executePreparedRequest(...)`, and the preparation and result contracts
2. optional portable wrapper: `AgentHarness`, which turns that flow into a preparedId-based tool contract
3. example-only runner: the OpenAI script plus its prompt and scenario scaffolding under `examples/`

The harness is intentionally narrow. It does not add a provider abstraction layer.

## Payload Visibility Limitation

The durable execution result stored by `AgentHarness` is not the same thing as automatically returning the merchant response body to the model.

What the model actually sees depends on the host tool implementation:

1. the harness can store deterministic execution state behind a `preparedId`
2. the tool host decides what parts of that state are returned in tool output
3. a durable stored result does not by itself guarantee that the model saw the full merchant payload

That distinction matters when evaluating transcripts or tool behavior.

## Tool Surface

The OpenAI example exposes exactly three model-callable tools:

1. `prepare_paid_request`
2. `execute_prepared_request`
3. `get_execution_result`

The intended flow is:

1. prepare a request
2. inspect `nextAction` and `validationIssues`
3. revise if needed
4. execute only when the prepared request is ready
5. read the stored execution result before giving a final summary

## Environment

The example runner expects:

```bash
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="https://402flow.ai"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="reporting-worker"
export X402FLOW_BOOTSTRAP_KEY="..."
```

Runtime-token auth also works if you set `X402FLOW_RUNTIME_TOKEN` instead of `X402FLOW_BOOTSTRAP_KEY`.

## Basic Run

Run the example with a direct prompt:

```bash
npm run example:openai-harness -- --prompt "Prepare and execute a paid POST request to https://merchant.example.com/images/generate with JSON body {\"prompt\":\"foggy coastline\"}"
```

You can also use a named preset and scenario:

```bash
npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario image-ready
```

## Flags

Supported flags:

1. `--model <id>` to override `OPENAI_MODEL`
2. `--preset <name>` to use a canned prompt preset
3. `--scenario <name>` to load a named scenario fixture pack
4. `--list-presets` to print available presets
5. `--list-scenarios` to print available scenarios
6. `--max-turns <n>` to cap the tool loop
7. `--ttl-ms <n>` to change prepared-request expiry for the session
8. `--transcript-file <path>` to persist the run transcript as JSON

The runner rejects using `--prompt` and `--preset` together.

## Presets

Built-in prompt presets:

1. `ready-json-post`: prepare and execute a JSON POST request using inline JSON or JSON fixture files for body, headers, and optional discovery metadata
2. `revise-json-post`: prepare a JSON POST request, revise once if validation issues require it, then execute only after the revised request is ready
3. `revise-get-query`: start with a bare GET URL, derive required query params from preparation hints, revise once, then execute
4. `inspect-only`: prepare once and stop after summarizing `nextAction` and `validationIssues`

For JSON-backed preset inputs, use either the inline `*_JSON` env var or the file-backed `*_FILE` env var for a given input, not both.

Supported preset inputs include:

1. `AGENT_HARNESS_TARGET_URL`
2. `AGENT_HARNESS_HEADERS_JSON` or `AGENT_HARNESS_HEADERS_FILE`
3. `AGENT_HARNESS_BODY_JSON` or `AGENT_HARNESS_BODY_FILE`
4. `AGENT_HARNESS_DISCOVERY_METADATA_JSON` or `AGENT_HARNESS_DISCOVERY_METADATA_FILE`
5. `AGENT_HARNESS_TASK` for some reasoning-oriented scenarios

## Transcripts

Use `--transcript-file` to write the prompt, tool calls, and final answer as JSON.

If you omit `--transcript-file` but use a named scenario, the runner defaults to:

```text
./tmp/<scenario>-run-<timestamp>.json
```

## More

For scenario packs, local paths, and public compatibility targets, see [docs/harness-scenarios.md](harness-scenarios.md).