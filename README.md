# @402flow/sdk

Paid HTTP SDK for AI agents with an inspectable prepare/execute flow.

It uses the 402flow control plane as the governance and execution backend, but the main developer surface is a small client for preparing and executing paid HTTP requests.

## Install

```bash
npm install @402flow/sdk
```

The published package supports Node 20+.

## Overview

`@402flow/sdk` is built for AI agents and other callers that need to inspect, prepare, and execute paid HTTP requests without embedding payment-protocol or governance logic in the host.

The SDK has one core client, `AgentPayClient`, and three main calls:

| API | Use when | What it does |
| --- | --- | --- |
| `fetchPaid(...)` | You already know the request shape | Probes if needed, resolves payment through the control plane, and returns passthrough or success |
| `preparePaidRequest(...)` | You want to inspect before paying | Returns normalized payment terms, request hints, validation issues, and `nextAction` |
| `executePreparedRequest(...)` | You already prepared the request | Executes the exact prepared request without re-probing first |

Use `fetchPaid(...)` for the simplest direct path.
Use `preparePaidRequest(...)` plus `executePreparedRequest(...)` when the caller needs an explicit inspect, revise, then execute loop.

The package also includes `AgentHarness`, an optional preparedId-based wrapper for tool hosts. That host-facing wrapper adds a human-readable `costSummary` on prepared results and ships canonical `defaultHarnessInstructions` plus `defaultHarnessToolSpecs` exports so adapters can reuse the same orchestration contract.

## Runtime Notes

Two constraints matter early in real integrations:

1. paid prepare and execute flows require replayable request bodies
2. the current replayable body types are `string` and `URLSearchParams`

That means JSON payloads should be sent as strings, and form-style payloads should be sent as `URLSearchParams`.

The SDK exports small helpers for that:

```ts
import {
  createFormUrlEncodedBody,
  createJsonRequestBody,
} from '@402flow/sdk';

const jsonBody = createJsonRequestBody({
  prompt: 'foggy coastline',
});

const formBody = createFormUrlEncodedBody({
  prompt: 'foggy coastline',
  style: 'noir',
  tags: ['coast', 'mist'],
});
```

`FormData`, `Blob`, streams, and framework-specific body wrappers are not currently accepted in paid flows because the SDK has to replay the exact request body through preparation and execution. Convert those upstream into a stable string or `URLSearchParams` first.

## Create A Client

Create one `AgentPayClient` per agent identity. The client binds the 402flow control-plane location and the organization plus agent selectors up front, and each request only carries request-specific context.

### Bootstrap key

For most SDK integrations, bootstrap-key auth is the recommended mode. The SDK exchanges it for a short-lived runtime token, caches that token, and refreshes it automatically before expiry.

```ts
import { AgentPayClient, createJsonRequestBody } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl: 'https://402flow.ai',
  organization: 'acme-labs',
  agent: 'reporting-worker',
  auth: {
    type: 'bootstrapKey',
    bootstrapKey: process.env.X402FLOW_BOOTSTRAP_KEY ?? '',
  },
});
```

### Runtime token

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl: 'https://402flow.ai',
  organization: 'acme-labs',
  agent: 'reporting-worker',
  auth: {
    type: 'runtimeToken',
    runtimeToken: process.env.X402FLOW_RUNTIME_TOKEN ?? '',
  },
});
```

## Fast Path: `fetchPaid()`

Call `fetchPaid()` when you already know the merchant URL, method, headers, and body.

```ts
try {
  const result = await client.fetchPaid(
    'https://merchant.example.com/reports/daily',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: createJsonRequestBody({
        date: '2026-03-25',
      }),
    },
    {
      description: 'sync daily paid report',
      idempotencyKey: 'daily-report-2026-03-25',
    },
  );

  const merchantBody = await result.response.json();
  console.log('merchant response body:', merchantBody);
} catch (error) {
  console.error('paid request failed', error);
  throw error;
}
```

If the merchant does not require payment for that exact request, the SDK returns a passthrough response. If the merchant returns a payable challenge, the SDK resolves payment through the control plane and returns a durable paid outcome.

`result.response` is always the merchant HTTP response. SDK-owned payment metadata such as `paidRequestId`, `paymentAttemptId`, `receiptId`, and `receipt` stays on the SDK result instead of being injected into the merchant JSON body.

### Interpreting Merchant Responses

The SDK gives you a stable place for payment metadata, but it does not invent a universal fulfilled-response schema for merchant content.

In practice:

1. the SDK result carries durable payment metadata such as `receiptId` and `receipt`
2. `result.response` carries the merchant fulfillment payload
3. the merchant contract decides where the useful paid content lives inside that payload

If you need request-shape guidance before execution, use `preparePaidRequest()` and inspect:

1. `prepared.hints` for authoritative request fields, examples, notes, and query/body guidance when the challenge publishes them
2. `prepared.challengeDetails` for raw merchant challenge data such as resource metadata, accepted payment candidates, and extensions like Bazaar discovery metadata
3. optional caller-supplied `externalMetadata` as advisory context only

If you do not have enough contract information to interpret a merchant response safely, return the raw merchant body and explain what is still missing instead of inventing a payload shape.

## Preparation Flow

Use `preparePaidRequest()` when the caller needs a first-class pre-execution result before paying.

```ts
import { createJsonRequestBody } from '@402flow/sdk';

const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      prompt: 'foggy coastline',
    }),
  },
);

if (prepared.kind === 'passthrough') {
  console.log('merchant did not require payment', prepared.probe?.responseStatus);
} else {
  console.log('protocol:', prepared.protocol);
  console.log('payment requirement:', prepared.paymentRequirement);
  console.log('request hints:', prepared.hints);
}

console.log('next action:', prepared.nextAction);
console.log('validation issues:', prepared.validationIssues);
```

This flow is useful when:

1. an agent needs request-shape hints before attempting execution
2. the caller wants normalized payment terms before paying
3. the caller wants to merge optional `externalMetadata` it already has from another system

The common loop is:

1. prepare the request
2. inspect `kind`, `paymentRequirement`, `hints`, `validationIssues`, and `nextAction`
3. revise if needed
4. execute only once the request is understood

If your system already has endpoint metadata, you can pass it in as optional context:

```ts
import { createJsonRequestBody } from '@402flow/sdk';

const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      prompt: 'foggy coastline',
    }),
  },
  {
    externalMetadata: {
      requestBodyType: 'json',
      requestBodyFields: [
        {
          name: 'prompt',
          type: 'string',
          required: true,
        },
      ],
    },
  },
);
```

`externalMetadata` is optional caller context. It improves preparation when the caller already has structured endpoint knowledge, but it is not required for normal SDK use.

### What `ready` Means

`ready` means this exact request can proceed through governed paid execution as-is; it does not mean the SDK has inferred the best task parameters for you.

That distinction matters:

1. `ready` is about protocol and payment executability
2. `validationIssues` and `hints` are about request-shape guidance
3. choosing semantically correct task parameters still belongs to the caller or agent

### Execute A Prepared Request

If preparation returns `kind === 'ready'`, execute that exact prepared request with `executePreparedRequest(prepared, ...)`.

```ts
import { createJsonRequestBody } from '@402flow/sdk';

const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      prompt: 'foggy coastline',
    }),
  },
);

if (prepared.kind === 'ready') {
  const result = await client.executePreparedRequest(prepared, {
    description: 'generate image',
    idempotencyKey: 'image-generate-foggy-coastline',
  });

  console.log('paid response status:', result.response.status);
}
```

If preparation does not return `kind === 'ready'`, that is not necessarily an error. It means this exact request did not currently resolve to a payable executable path. The caller can accept that result, run a normal non-paid path, or revise and prepare again.

## Prepared Result Semantics

`preparePaidRequest()` separates request checking from paid execution.

The preparation result distinguishes four important things:

1. `paymentRequirement`: normalized payment terms derived from the merchant challenge when available
2. `hints`: request-shape hints such as body fields, query params, path params, descriptions, examples, and notes
3. `validationIssues`: structured remediation diagnostics derived from the current request and defensible preparation inputs
4. `nextAction`: the authoritative machine contract for what to do next, such as `execute`, `revise_request`, or `treat_as_passthrough`

Each prepared hint carries `attribution` so callers can distinguish live merchant-authoritative data from advisory caller-supplied metadata.

In this model, payment terms come from the merchant challenge, optional request-shape enrichment comes from `externalMetadata`, and live confirmation is represented by the prepared `probe` result.

## Result And Error Semantics

`fetchPaid()` and `executePreparedRequest()` either:

1. return a passthrough response when the request did not require payment
2. return `success` with a receipt when the paid request completed successfully
3. throw `FetchPaidError` for all non-success paid outcomes

`FetchPaidError` kinds are:

1. `denied`
2. `preflight_failed`
3. `execution_pending`
4. `execution_failed`
5. `paid_fulfillment_failed`
6. `execution_inconclusive`
7. `request_failed`

Receipt notes:

1. `receipt.status = 'confirmed'` means the control plane has chain-backed settlement attribution for the paid attempt
2. `receipt.status = 'provisional'` means the paid outcome was supportable by merchant-provided evidence, but final settlement attribution is still pending reconciliation
3. callers should treat provisional receipts as payment-attempt evidence, not as proof of final settlement
4. if you safely retry the same logical paid request with the same `idempotencyKey`, the SDK returns the same durable paid outcome instead of creating a second paid attempt

## Receipt Lookup

```ts
const receipt = await client.lookupReceipt('receipt-id');

console.log(receipt.receipt.status);
```

## Canonical Host Metadata

If you are building a tool host, do not copy orchestration rules into ad hoc prompts. Import the canonical host-agnostic metadata from the SDK and adapt it to your model provider.

```ts
import {
  defaultHarnessInstructions,
  defaultHarnessToolSpecs,
} from '@402flow/sdk';

console.log(defaultHarnessInstructions);
console.log(defaultHarnessToolSpecs);
```

`defaultHarnessToolSpecs` defines the canonical three-tool contract:

1. `prepare_paid_request`
2. `execute_prepared_request`
3. `get_execution_result`

Those descriptions encode the orchestration rules, including:

1. `nextAction` is authoritative
2. execute only after `nextAction === 'execute'`
3. read the stored execution result before summarizing the outcome

Keep provider-specific tool objects in your host adapter, not in the SDK core package.

## Tiny OpenAI Tools Host

If you want a minimal real host integration instead of the larger evaluation harness, use the tiny OpenAI Responses example in `examples/openai-tools-quickstart.mjs`.

For repo-local example runs, create `.env` from `.env.example` in the SDK root. The SDK examples load that file directly, so scenario runs stay self-contained in this repo whether they point at a local control plane or a hosted environment.

It keeps the host story narrow:

1. create an `AgentPayClient`
2. wrap it with optional `AgentHarness` so tool calls can pass `preparedId`
3. build provider-specific tool objects from `defaultHarnessToolSpecs`
4. expose `prepare_paid_request`, `execute_prepared_request`, and `get_execution_result`

Run it with one prompt. Either populate `.env` from `.env.example`, or export the same values in your shell for a one-off run:

```bash
cp .env.example .env
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="https://402flow.ai"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="reporting-worker"
export X402FLOW_BOOTSTRAP_KEY="..."

npm run example:openai-tools-quickstart -- \
  "Prepare and execute a paid POST request to https://nickeljoke.vercel.app/api/joke with JSON body {\"topic\":\"sdk integration\",\"tone\":\"dry\",\"audience\":\"platform engineers\"}"
```

Use this when you want the shortest real host integration path. Use the full evaluation harness only when you need scenarios, transcripts, or repeated eval runs.

## Optional `AgentHarness`

`AgentHarness` is an optional preparedId-based wrapper for tool hosts that do not want to manage in-flight prepared request objects themselves. It is a convenience layer on top of `AgentPayClient`, not a required abstraction.

Key behavior:

1. preparations are stored in memory behind a `preparedId`
2. a newer active preparation for the same method plus origin plus pathname supersedes the older one
3. duplicate execute calls for the same consumed `preparedId` are rejected locally as already consumed
4. hosts should call `getExecutionResult(preparedId)` after execution to read the durable stored outcome
5. host-facing prepare results include `costSummary`, for example `Costs 0.001000 USDC on Base Sepolia (exact).`

For harness usage, presets, transcripts, and scenario packs, see:

1. [docs/evaluation-harness.md](docs/evaluation-harness.md)
2. [docs/harness-scenarios.md](docs/harness-scenarios.md)

## Publish

```bash
npm install
npm run check
npm run pack:check
npm publish --access public
```