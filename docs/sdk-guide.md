# SDK Guide

This guide holds the longer-form usage material for `@402flow/sdk`.

For the package front door, start with the root [README](../README.md).
For model-host details, see [evaluation-harness.md](evaluation-harness.md).
For scenario packs and first-party versus third-party evaluation paths, see [harness-scenarios.md](harness-scenarios.md).

## Install

```bash
npm install @402flow/sdk
```

Optional official adapters for third-party payers:

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

The published package supports Node 20+.

## Runtime Notes

Two runtime constraints matter early in real integrations:

1. paid prepare and execute flows require replayable request bodies
2. the current replayable body types are `string` and `URLSearchParams`

That means JSON payloads should be sent as strings, and form-style payloads should be sent as `URLSearchParams`.

The SDK exports helpers for both:

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

`FormData`, `Blob`, streams, and framework-specific body wrappers are not currently accepted in paid flows because the SDK has to replay the exact request body through preparation and execution.

## Create A Client

Create one `AgentPayClient` per agent identity.

### Bootstrap Key

For most SDK integrations, bootstrap-key auth is the recommended mode. The SDK exchanges it for a short-lived runtime token, caches that token, and refreshes it automatically before expiry.

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl:
    process.env.X402FLOW_CONTROL_PLANE_BASE_URL ?? 'https://api-staging.402flow.ai',
  organization: process.env.X402FLOW_ORGANIZATION ?? 'acme-labs',
  agent: process.env.X402FLOW_AGENT ?? 'reporting-worker',
  auth: {
    type: 'bootstrapKey',
    bootstrapKey: process.env.X402FLOW_BOOTSTRAP_KEY ?? '',
  },
});
```

### Runtime Token

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl:
    process.env.X402FLOW_CONTROL_PLANE_BASE_URL ?? 'https://api-staging.402flow.ai',
  organization: process.env.X402FLOW_ORGANIZATION ?? 'acme-labs',
  agent: process.env.X402FLOW_AGENT ?? 'reporting-worker',
  auth: {
    type: 'runtimeToken',
    runtimeToken: process.env.X402FLOW_RUNTIME_TOKEN ?? '',
  },
});
```

## Fast Path: `fetchPaid()`

Call `fetchPaid()` when you already know the merchant URL, method, headers, and body.

```ts
import {
  AgentPayClient,
  createJsonRequestBody,
} from '@402flow/sdk';

const result = await client.fetchPaid(
  'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      topic: 'sdk integration rollout',
      audience: 'platform engineers',
      format: 'bullets',
    }),
  },
  {
    description: 'generate a staged research brief',
    idempotencyKey: 'solana-devnet-sdk-guide-brief',
  },
);

console.log(await result.response.json());
console.log(result.receiptId);
```

If the merchant does not require payment for that exact request, the SDK returns a passthrough response.
If the merchant returns a payable challenge, the SDK asks the control plane for a paid decision, resolves payment, and returns a receipt-backed paid response.

`result.response` is always the merchant HTTP response.
SDK-owned payment metadata such as `paidRequestId`, `paymentAttemptId`, `receiptId`, and `receipt` stays on the SDK result instead of being injected into the merchant JSON body.

### Important Probe Semantics

When you do not supply `request.challenge` to `fetchPaid()` or `options.challenge` to `preparePaidRequest()`, the SDK first sends the original HTTP request to the merchant to detect whether payment is required.

That initial merchant probe happens before any control-plane authorization or settlement attempt.

For non-idempotent `POST` routes, only use probe-based flows when the merchant explicitly supports safe probing, or when you already have a merchant challenge and pass it to the SDK directly.

### Optional Attribution

Most integrations do not need attribution at all.

Use it when you already know where the endpoint came from and want that provenance to survive into control-plane audit and reporting.

```ts
const result = await client.fetchPaid(
  'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      topic: 'base sepolia rollout',
      audience: 'platform engineers',
      format: 'bullets',
    }),
  },
  {
    description: 'generate a base sepolia brief',
    attribution: {
      discoverySource: 'direct',
    },
  },
);
```

## Inspect First: `preparePaidRequest()`

Use `preparePaidRequest()` when the caller needs a first-class pre-execution result before paying.

```ts
import { createJsonRequestBody } from '@402flow/sdk';

const prepared = await client.preparePaidRequest(
  'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: createJsonRequestBody({
      topic: 'sdk integration rollout',
    }),
  },
);

console.log(prepared.nextAction);
console.log(prepared.validationIssues);
console.log(prepared.hints);
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

### `externalMetadata` vs `attribution`

These two inputs solve different problems.

1. `externalMetadata` helps the SDK understand request shape before execution
2. `attribution` helps the control plane explain where the paid endpoint came from after execution

Use `externalMetadata` for request hints.
Use `attribution` for provenance.

### What `ready` Means

`ready` means this exact request can proceed through governed paid execution as-is.
It does not mean the SDK has inferred the best task parameters for you.

That distinction matters:

1. `ready` is about protocol and payment executability
2. `validationIssues` and `hints` are about request-shape guidance
3. choosing semantically correct task parameters still belongs to the caller or agent

## Execute A Prepared Request

If preparation returns `kind === 'ready'` and `nextAction === 'execute'`, execute that exact request with `executePreparedRequest(prepared, ...)`.

```ts
if (prepared.kind === 'ready' && prepared.nextAction === 'execute') {
  const result = await client.executePreparedRequest(prepared, {
    description: 'generate a staged research brief',
    idempotencyKey: 'execute-prepared-solana-devnet-brief',
  });

  console.log(result.response.status);
}
```

If preparation does not return `kind === 'ready'`, that is not necessarily an error.
It means this exact request did not currently resolve to a payable executable path.

## Interpreting Merchant Responses

The SDK gives you a stable place for payment metadata, but it does not invent a universal fulfilled-response schema for merchant content.

In practice:

1. the SDK result carries durable payment metadata such as `receiptId` and `receipt`
2. `result.response` carries the merchant fulfillment payload
3. the merchant contract decides where the useful paid content lives inside that payload

If you need request-shape guidance before execution, use `preparePaidRequest()` and inspect:

1. `prepared.hints` for authoritative request fields, examples, notes, and query or body guidance when the challenge publishes them
2. `prepared.challengeDetails` for raw merchant challenge data such as accepted payment candidates and extensions
3. optional caller-supplied `externalMetadata` as advisory context only

If you do not have enough contract information to interpret a merchant response safely, return the raw merchant body and explain what is still missing instead of inventing a payload shape.

## Delegated Execution With Third-Party Payers

`executePreparedRequest()` supports governed delegated execution through a caller-supplied executor interface.

Once a payable challenge is already known, this lets the SDK keep authorization, policy, receipts, and final outcome normalization in the 402flow control plane while handing the final paid merchant call to a provider-specific executor owned by the host app or a separate integration package.

That means you can use Dexter, pay.sh, or a host-owned executor without turning the main SDK into a provider-specific bundle.

```ts
import {
  type PreparedRequestExecutor,
} from '@402flow/sdk';

const dexterExecutor: PreparedRequestExecutor = {
  provider: 'dexter',
  async execute({ prepared }) {
    const dexterResult = await callDexter(prepared);

    return {
      protocol: prepared.protocol,
      executionStatus: 'succeeded',
      settlementEvidenceClass: 'settled',
      merchantOutcome: 'success_response',
      merchantResponse: {
        status: dexterResult.status,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(dexterResult.body),
      },
      settlementReference: dexterResult.settlementReference,
      paymentReference: dexterResult.paymentReference,
    };
  },
};

if (prepared.kind === 'ready' && prepared.nextAction === 'execute') {
  const result = await client.executePreparedRequest(prepared, {
    description: 'execute through Dexter',
    executionProvider: 'dexter',
    executor: dexterExecutor,
  });

  console.log(result.response.status);
}
```

Responsibility split:

1. the SDK asks the control plane for delegated authorization
2. if authorized, the SDK invokes your executor
3. your executor performs the provider-specific paid request and returns a normalized result
4. the SDK finalizes that result with the control plane
5. the SDK returns the same outward `PaidResponse` or `FetchPaidError` contract as the direct path

Official adapters live in `@402flow/sdk-third-party-executors` and the repo-local source for them lives in `third-party-executors/`.

Prefer the provider-specific subpath you actually use:

```ts
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

## Result And Receipt Semantics

`fetchPaid()` and `executePreparedRequest()` either:

1. return a passthrough response when the request did not require payment
2. return success with a receipt when the paid request completed successfully
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
4. `idempotencyKey` is optional for normal SDK use, but you should set it for retrying callers or automation loops where duplicate suppression matters

## Receipt Lookup

```ts
const receipt = await client.lookupReceipt('receipt-id');

console.log(receipt.receipt.status);
```

## Canonical Host Metadata

If you are building a tool host, do not copy orchestration rules into ad hoc prompts.
Import the canonical host-agnostic metadata from the SDK and adapt it to your model provider.

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

## Related Docs

- [Root README](../README.md)
- [Evaluation harness](evaluation-harness.md)
- [Harness scenarios](harness-scenarios.md)
- [Third-party executors](../third-party-executors/README.md)
- [Publishing](releasing.md)