# Evaluation Runner on AgentHarness

This document covers the example evaluation runner under `examples/`. The runner
is built on `AgentHarness` (`src/agent-harness.ts`). There is no separate SDK
module named `evaluation-harness`, and the runner is not part of the core SDK
contract: `AgentPayClient`, `fetchPaid()`, `preparePaidRequest()`, and
`executePreparedRequest()`.

## Why `preparedId`

`AgentHarness` gives a model host a tool surface keyed by `preparedId`. The host
keeps the full prepared request in process memory and gives the model a short
opaque ID. Later tool calls use that ID to execute the request or read the
stored result.

Passing a short ID between turns is easier, safer, and cheaper than asking the
model to reproduce a large prepared object exactly. If your application can hold
the prepared object itself, use the core SDK directly.

The repository has two OpenAI Responses examples built on the harness: the small
`examples/openai-tools-quickstart.mjs` and the larger evaluation runner
`examples/openai-agent-harness.mjs`.

## Boundary

1. Core SDK: `AgentPayClient`, `preparePaidRequest()`, `executePreparedRequest()`, and their preparation and result contracts.
2. Optional wrapper: `AgentHarness`, which exposes that flow as a `preparedId`-based tool contract.
3. Example runners: the OpenAI quickstart, the evaluation runner, and the scenario files under `examples/`.

`AgentHarness` adds no provider abstraction layer.

## What The Model Sees

The harness stores execution state behind a `preparedId`, and the host's tool
implementation decides which parts of that state to return to the model. A
stored result does not prove that the model saw the full merchant payload. When
you evaluate a transcript, check what the tools actually returned.

## Tool Surface

The OpenAI examples expose exactly three model-callable tools:

1. `prepare_paid_request`
2. `execute_prepared_request`
3. `get_execution_result`

The examples build these tools from the host-agnostic metadata that the SDK
exports, `defaultHarnessInstructions` and `defaultHarnessToolSpecs`, rather than
from OpenAI-specific prompt text. Every host adapter uses the same contract:

1. Prepare every request before any paid execution.
2. Execute only when preparation returns `nextAction: execute`.
3. On `treat_as_passthrough`, do not pay. Explain that payment is not required.
4. On `revise_request`, use `validationIssues` and hints to revise only when the task supplies enough information. Otherwise, stop and say what is missing.
5. Use `externalMetadata` only when the caller already has endpoint metadata. Treat it as advisory when it disagrees with merchant challenge hints.
6. Do not invent missing business parameters. Do not execute the same prepared request twice unless the caller explicitly asks for a retry.
7. After execution, read the stored result and report denied, pending, failed, or inconclusive outcomes clearly.

The OpenAI examples return the harness prepare result directly from the tool
handler. The model must call `get_execution_result` before it summarizes the
outcome.

## Prepared Surface

The prepare result that `AgentHarness` returns to the host includes:

1. `preparedId` and `preparationLineageId`
2. `kind` and `nextAction`
3. `costSummary`, a human-readable payment summary for the agent
4. `paymentRequirement` and `challengeDetails`
5. `hints` and `validationIssues`
6. `expiresAt`

`challengeDetails` and `paymentRequirement` remain visible by default. The
Bazaar revise scenarios still depend on the merchant challenge, and it is not
yet proven that `hints` can replace everything useful in
`challengeDetails.extensions`. Treat `hints` as the main revise surface, and keep
`challengeDetails` visible until revise coverage shows it is safe to hide.

## Storage And Execution

`AgentHarness` keeps prepared state in memory behind `preparedId`:

1. State and results live only in the current process. They do not survive a restart and are not shared across hosts.
2. Prepared records expire after five minutes by default (`preparedTtlMs`). Expiry is checked when a record is accessed; there is no background cleanup.
3. Each preparation belongs to a lineage identified by `preparationLineageId`. Passing an earlier `preparationLineageId` into a new prepare call supersedes the active preparations in that lineage only. Preparations in different lineages never supersede one another, even for the same endpoint.
4. Concurrent execute calls for the same active `preparedId` share one in-flight execution within the process.
5. A dispatched `preparedId` is consumed when execution settles, including when a transport error escapes without a known outcome. The caller still receives the error, and later execute calls return a stable harness-local rejection.
6. A consumed record without an execution result does not prove that no payment occurred. Reconcile the outcome and follow the [retry guidance](compatibility.md#safe-retries) before an explicit retry.
7. An explicit retry needs a new preparation. For the same URL, method, body, agent identity, and business operation, pass the original business idempotency key in `executionContext`.

## Environment

Create an SDK-local env file:

```bash
cp .env.example .env
```

The runner loads `.env.local` and `.env` from the SDK root. Variables already
exported in the shell take precedence. The runner never reads another
repository's env file.

Set these values:

```ini
OPENAI_API_KEY="..."
X402FLOW_CONTROL_PLANE_BASE_URL="https://api-staging.402flow.ai"
X402FLOW_ORGANIZATION="acme-labs"
X402FLOW_AGENT="research-worker"
X402FLOW_BOOTSTRAP_KEY="..."
```

For runtime-token auth, set `X402FLOW_RUNTIME_TOKEN` instead of
`X402FLOW_BOOTSTRAP_KEY`. To use a local control plane instead of staging, change
`X402FLOW_CONTROL_PLANE_BASE_URL`.

First-party scenarios use the hosted demo merchant at
`https://demo-merchant-staging.402flow.ai`. To use a self-hosted demo merchant,
set `X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL="http://127.0.0.1:4123"`.

## Basic Run

The smallest host example:

```bash
npm run example:openai-tools-quickstart -- --help
```

The evaluation runner with a direct prompt:

```bash
npm run example:openai-harness -- --prompt "Prepare and execute a paid POST request to https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet with JSON body {\"topic\":\"sdk integration rollout\",\"audience\":\"platform engineers\",\"format\":\"bullets\"}"
```

The evaluation runner with a named preset and scenario:

```bash
npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario nickeljoke-compat
```

## Flags

1. `--prompt <text>`: run a direct prompt
2. `--preset <name>`: use a built-in prompt preset
3. `--scenario <name>`: load a named scenario fixture pack
4. `--list-presets`: print the available presets
5. `--list-scenarios`: print the available scenarios
6. `--model <id>`: override `OPENAI_MODEL` (default `gpt-5.4`)
7. `--max-turns <n>`: cap the tool loop
8. `--ttl-ms <n>`: change prepared-request expiry for the session
9. `--transcript-file <path>`: save the run transcript as JSON

`--prompt` and `--preset` cannot be combined.

## Presets

1. `ready-json-post`: prepare and execute a JSON POST request, with the body, headers, and optional external metadata supplied as inline JSON or JSON files
2. `revise-json-post`: prepare a JSON POST request, revise once if validation issues require it, and execute only after the revised request is ready
3. `revise-get-query`: start with a bare GET URL, derive the required query parameters from preparation hints, revise once, and execute
4. `inspect-only`: prepare once, then stop after summarizing `nextAction` and `validationIssues`
5. `mock-governance`: run the normal prepare, execute, and get-result loop against mocked governance outcomes, such as denials, preflight failures, and inconclusive execution

Presets read these inputs from the environment:

1. `AGENT_HARNESS_TARGET_URL`
2. `AGENT_HARNESS_HEADERS_JSON` or `AGENT_HARNESS_HEADERS_FILE`
3. `AGENT_HARNESS_BODY_JSON` or `AGENT_HARNESS_BODY_FILE`
4. `AGENT_HARNESS_EXTERNAL_METADATA_JSON` or `AGENT_HARNESS_EXTERNAL_METADATA_FILE`
5. `AGENT_HARNESS_TASK`, for some reasoning-oriented scenarios

Set either the inline `*_JSON` variable or the `*_FILE` variable for each input,
not both.

## Transcripts

`--transcript-file` writes the prompt, tool calls, and final answer as JSON. With
a named scenario and no `--transcript-file`, the runner writes to:

```text
./tmp/scenario-runs/<scenario>-run-<timestamp>.json
```

## Scenarios

For scenario packs, self-hosted merchant paths, and public compatibility
targets, see [harness-scenarios.md](harness-scenarios.md).