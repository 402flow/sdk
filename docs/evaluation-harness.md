# Evaluation Runner on AgentHarness

This document covers the optional evaluation runner built on top of `AgentHarness`.

It does not describe a second SDK module named `evaluation-harness`. The reusable SDK wrapper is `AgentHarness` in `src/agent-harness.ts`; this document is about the example runner and its supporting files under `examples/`.

It is not the core SDK contract. The core package surface remains:

1. `AgentPayClient`
2. `preparePaidRequest(...)`
3. `executePreparedRequest(...)`
4. `fetchPaid(...)`

Use the harness when you want a preparedId-based tool surface for a model host, especially the repo-local OpenAI Responses examples under `examples/openai-tools-quickstart.mjs` and `examples/openai-agent-harness.mjs`.

That means the host stores the full prepared request state and gives the model a small opaque `preparedId` instead of asking it to carry the entire prepared object across turns. Later tool calls use that `preparedId` to execute the prepared request or read back the stored result.

This matters for tool-calling hosts because passing a short stable id between turns is usually easier, safer, and cheaper than expecting the model to preserve a larger structured prepared request exactly. If your application can safely hold the prepared object itself, use the core SDK directly instead of `AgentHarness`.

## Boundary

The boundary is:

1. core SDK: `AgentPayClient`, `preparePaidRequest(...)`, `executePreparedRequest(...)`, and the preparation and result contracts
2. optional portable wrapper: `AgentHarness`, which turns that flow into a preparedId-based tool contract
3. example-only runners: the tiny OpenAI quickstart plus the larger evaluation script and scenario scaffolding under `examples/`

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

Those tool definitions are not maintained as OpenAI-only prompt text. The example runtime imports the canonical host-agnostic metadata exported by the SDK:

1. `defaultHarnessInstructions`
2. `defaultHarnessToolSpecs`

That keeps the orchestration contract in one place while still letting each host adapter build provider-specific tool objects.

At a high level, the canonical contract is:

1. always prepare a request before any paid execution
2. execute only when preparation returns `nextAction: execute`
3. if preparation returns `treat_as_passthrough`, do not pay and explain that paid execution is not required
4. if preparation returns `revise_request`, use `validationIssues` and hints to revise only when the task provides enough information; otherwise stop and explain what is still missing
5. use `externalMetadata` only when the caller already has endpoint metadata, and treat it as advisory when merchant challenge hints disagree
6. do not invent missing business parameters or execute the same prepared request twice unless the caller explicitly asks for a retry
7. after execution, read the stored execution result and report denied, pending, failed, or inconclusive outcomes clearly

The OpenAI example follows that contract by returning the harness prepare result directly from the tool handler, then requiring the model to call `get_execution_result` before summarizing the outcome.

## Prepared Surface

Today, the host-facing prepare result returned by `AgentHarness` includes:

1. `preparedId`
2. `costSummary`
3. `challengeDetails`
4. `paymentRequirement`
5. `hints`
6. `validationIssues`
7. `nextAction`

`costSummary` is the human-readable payment summary intended for agent-facing use.

`challengeDetails` and `paymentRequirement` are still surfaced by default. That is intentional for now. Bazaar-style revise scenarios still validate the current merchant-challenge path, and the SDK has not yet proven that `hints` alone fully replaces every useful piece of `challengeDetails.extensions` in agent-facing flows.

So the current rule is:

1. prefer `hints` as the main revise surface
2. keep `challengeDetails` visible by default until revise coverage proves it is safe to hide

## Duplicate Execute Semantics

`AgentHarness` keeps prepare state in memory behind `preparedId`.

Important behavior:

1. a newer active preparation for the same method plus origin plus pathname supersedes the older one
2. duplicate execute calls for a consumed `preparedId` return a stable harness-local rejection instead of creating another payment attempt implicitly
3. hosts should prepare again if they want an explicit retry path

## Environment

Create a repo-local SDK env file first:

```bash
cp .env.example .env
```

The example runner loads `.env.local` and `.env` from the SDK root, then keeps any already-exported shell environment values.

The expected SDK environment values are:

```bash
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="https://402flow.ai"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="reporting-worker"
export X402FLOW_BOOTSTRAP_KEY="..."
```

Runtime-token auth also works if you set `X402FLOW_RUNTIME_TOKEN` instead of `X402FLOW_BOOTSTRAP_KEY`.

That keeps the evaluation runner self-contained in the SDK repo. The control plane can still be local `agent-pay`, but the SDK examples no longer depend on reading another repository's env file.

## Basic Run

For the smallest runnable host example:

```bash
npm run example:openai-tools-quickstart -- --help
```

For the larger evaluation runner, use a direct prompt:

```bash
npm run example:openai-harness -- --prompt "Prepare and execute a paid POST request to http://127.0.0.1:4123/demo-merchant/research-brief/solana-devnet with JSON body {\"topic\":\"sdk integration rollout\",\"audience\":\"platform engineers\",\"format\":\"bullets\"}"
```

You can also use a named preset and scenario:

```bash
npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario nickeljoke-compat
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

1. `ready-json-post`: prepare and execute a JSON POST request using inline JSON or JSON fixture files for body, headers, and optional external metadata
2. `revise-json-post`: prepare a JSON POST request, revise once if validation issues require it, then execute only after the revised request is ready
3. `revise-get-query`: start with a bare GET URL, derive required query params from preparation hints, revise once, then execute
4. `inspect-only`: prepare once and stop after summarizing `nextAction` and `validationIssues`
5. `mock-governance`: run the normal prepare, execute, and get-result loop against fixture-driven mocked governance outcomes such as denials, preflight failures, and inconclusive execution

For JSON-backed preset inputs, use either the inline `*_JSON` env var or the file-backed `*_FILE` env var for a given input, not both.

Supported preset inputs include:

1. `AGENT_HARNESS_TARGET_URL`
2. `AGENT_HARNESS_HEADERS_JSON` or `AGENT_HARNESS_HEADERS_FILE`
3. `AGENT_HARNESS_BODY_JSON` or `AGENT_HARNESS_BODY_FILE`
4. `AGENT_HARNESS_EXTERNAL_METADATA_JSON` or `AGENT_HARNESS_EXTERNAL_METADATA_FILE`
5. `AGENT_HARNESS_TASK` for some reasoning-oriented scenarios

## Transcripts

Use `--transcript-file` to write the prompt, tool calls, and final answer as JSON.

If you omit `--transcript-file` but use a named scenario, the runner defaults to:

```text
./tmp/<scenario>-run-<timestamp>.json
```

## More

For scenario packs, local paths, and public compatibility targets, see [docs/harness-scenarios.md](harness-scenarios.md).