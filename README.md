# @402flow/sdk

Node.js SDK for making governed paid HTTP requests through the 402flow control plane.

## Install

```bash
npm install @402flow/sdk
```

## Overview

`@402flow/sdk` is built for AI agents and other callers that need to check, prepare, and execute paid HTTP requests without embedding control-plane or protocol-specific logic in the host.

The SDK has one core client, `AgentPayClient`, and three main calls:

| API | Use when | What it does |
| --- | --- | --- |
| `fetchPaid(...)` | You already know the request shape | Probes if needed, resolves payment through the control plane, and returns passthrough or success |
| `preparePaidRequest(...)` | You want to inspect before paying | Returns normalized payment terms, request hints, validation issues, and `nextAction` |
| `executePreparedRequest(...)` | You already prepared the request | Executes the exact prepared request without re-probing first |

Use `fetchPaid(...)` for the simplest direct path.
Use `preparePaidRequest(...)` plus `executePreparedRequest(...)` when the caller needs an explicit inspect, revise, then execute loop.

The package also includes `AgentHarness`, an optional preparedId-based wrapper for tool hosts. It is a convenience layer on top of `AgentPayClient`, not part of the core client API.

## Create A Client

Create one `AgentPayClient` per agent identity. The client binds the organization and agent selectors up front, and each request only carries request-specific context.

### Bootstrap key

For most SDK integrations, bootstrap-key auth is the recommended mode. The SDK exchanges it for a short-lived runtime token, caches that token, and refreshes it automatically before expiry.

```ts
import { AgentPayClient } from '@402flow/sdk';

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
      body: JSON.stringify({
        date: '2026-03-25',
      }),
    },
    {
      description: 'sync daily paid report',
      idempotencyKey: 'daily-report-2026-03-25',
    },
  );

  const paidContent = await result.response.json();
  console.log('paid content:', paidContent);
} catch (error) {
  console.error('paid request failed', error);
  throw error;
}
```

If the merchant does not require payment for that exact request, the SDK returns a passthrough response. If the merchant returns a payable challenge, the SDK resolves payment through the control plane and returns a durable paid outcome.

## Preparation Flow

Use `preparePaidRequest()` when the caller needs a first-class pre-execution result before paying.

```ts
const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
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
3. the caller wants to merge optional `discoveryMetadata` it already has from another system

The common loop is:

1. prepare the request
2. inspect `kind`, `paymentRequirement`, `hints`, `validationIssues`, and `nextAction`
3. revise if needed
4. execute only once the request is understood

If your system already has endpoint metadata, you can pass it in as optional context:

```ts
const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: 'foggy coastline',
    }),
  },
  {
    discoveryMetadata: {
      provider: {
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
  },
);
```

`discoveryMetadata` is optional caller context. It improves preparation when the caller already has structured endpoint knowledge, but it is not required for normal SDK use.

### What `ready` Means

`ready` means this exact request can proceed through governed paid execution as-is; it does not mean the SDK has inferred the best task parameters for you.

That distinction matters:

1. `ready` is about protocol and payment executability
2. `validationIssues` and `hints` are about request-shape guidance
3. choosing semantically correct task parameters still belongs to the caller or agent

### Execute A Prepared Request

If preparation returns `kind === 'ready'`, execute that exact prepared request with `executePreparedRequest(prepared, ...)`.

```ts
const prepared = await client.preparePaidRequest(
  'https://merchant.example.com/images/generate',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
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
4. `nextAction`: a narrow action summary such as `execute`, `revise_request`, or `treat_as_passthrough`

Each prepared hint carries `attribution` so callers can distinguish live merchant-authoritative data from advisory caller-supplied metadata.

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

## Minimal Agent Integration Contract

Most agent frameworks only need a small orchestration policy:

```text
When using @402flow/sdk:
- Always prepare a paid request before executing it.
- If preparation returns revise_request, inspect validationIssues and hints, revise the request, and prepare again.
- Do not invent discoveryMetadata unless the caller already has it from another system.
- Use merchant-challenge hints to understand request shape, but use the task and available business context to choose actual parameter values.
- Execute only after preparation shows the request is ready.
```

That is the portable core SDK story. It should work across OpenAI, Claude, LangGraph, MCP, or custom workflows without requiring host-specific packaging in the SDK contract itself.

## Optional `AgentHarness`

`AgentHarness` is an optional preparedId-based wrapper for tool hosts that do not want to manage in-flight prepared request objects themselves. It is a convenience layer on top of `AgentPayClient`, not a required abstraction.

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