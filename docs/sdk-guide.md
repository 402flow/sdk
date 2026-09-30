# SDK Guide

This guide covers `@402flow/sdk` in more depth than the root
[README](../README.md). For model-host wrappers, see
[evaluation-harness.md](evaluation-harness.md). For scenario packs, see
[harness-scenarios.md](harness-scenarios.md). For a hosted agent that makes a
governed testnet purchase, see the
[OpenAI Agents API reference integration](../examples/openai-agents-api/README.md).

## Install

```bash
npm install @402flow/sdk
```

The SDK requires Node 20 or newer. To delegate payment to Dexter or pay.sh, also
install the optional adapter package:

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

## Request Bodies

Paid flows replay the exact request body through preparation and execution, so
the body must be a `string` or `URLSearchParams`. Send JSON as a string and form
data as `URLSearchParams`. The SDK exports a helper for each:

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

`FormData`, `Blob`, streams, and framework-specific body wrappers are not
accepted in paid flows.

## Create A Client

Create one `AgentPayClient` per agent identity.

### Bootstrap Key

Bootstrap-key auth is the recommended mode for most integrations. The SDK
exchanges the key for a short-lived runtime token, caches the token, and
refreshes it before it expires.

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl:
    process.env.X402FLOW_CONTROL_PLANE_BASE_URL ?? 'https://api-staging.402flow.ai',
  organization: process.env.X402FLOW_ORGANIZATION ?? 'acme-labs',
  agent: process.env.X402FLOW_AGENT ?? 'research-worker',
  auth: {
    type: 'bootstrapKey',
    bootstrapKey: process.env.X402FLOW_BOOTSTRAP_KEY ?? '',
  },
});
```

### Runtime Token

If you already have a runtime token, pass it directly:

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
  controlPlaneBaseUrl:
    process.env.X402FLOW_CONTROL_PLANE_BASE_URL ?? 'https://api-staging.402flow.ai',
  organization: process.env.X402FLOW_ORGANIZATION ?? 'acme-labs',
  agent: process.env.X402FLOW_AGENT ?? 'research-worker',
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
if (result.kind === 'success') {
  console.log(result.receiptId);
}
```

If the merchant does not require payment for that exact request, the SDK returns
a passthrough response. If the merchant returns a payable challenge, the SDK asks
the control plane for a decision, pays, and returns a paid response with a
receipt.

`result.response` is always the merchant's HTTP response. Payment metadata such
as `paidRequestId`, `paymentAttemptId`, `receiptId`, and `receipt` is on the SDK
result. The SDK does not inject it into the merchant body.

### Merchant Probe

When you do not pass `request.challenge` to `fetchPaid()` or
`options.challenge` to `preparePaidRequest()`, the SDK first sends the original
request to the merchant to detect whether payment is required. This probe
happens before any control-plane authorization or settlement.

For non-idempotent `POST` routes, rely on the probe only when the merchant
supports safe probing. Otherwise, pass the challenge you already have.

The original `RequestInit.signal` applies to this probe. A prepared request does
not store the signal. To time out every merchant and control-plane call, provide
a custom `fetch` when you create the client. See
[`examples/typescript/timeout-client.ts`](../examples/typescript/timeout-client.ts).

### Optional Attribution

Most integrations do not need attribution. Use it when you know where the
endpoint came from and want that provenance recorded in control-plane audit and
reporting.

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

Use `preparePaidRequest()` to inspect a request before paying.

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

Preparation helps when:

1. an agent needs request-shape hints before execution
2. the caller wants normalized payment terms before paying
3. the caller has `externalMetadata` from another system to merge in

The usual loop is to prepare the request; inspect `kind`, `paymentRequirement`,
`hints`, `validationIssues`, and `nextAction`; revise if needed; and execute
only when `kind === 'ready'` and `nextAction === 'execute'`.

### `externalMetadata` vs `attribution`

`externalMetadata` describes the request shape before execution. The SDK treats
it as advisory. `attribution` records where the endpoint came from, for
control-plane audit and reporting after execution.

### What `ready` Means

`ready` means this exact request can proceed through governed paid execution as
it is. It covers protocol and payment executability only. `validationIssues` and
`hints` give request-shape guidance, and the caller or agent still chooses the
task parameters. The SDK does not infer the best parameters.

## Execute A Prepared Request

When preparation returns `kind === 'ready'` and `nextAction === 'execute'`, pass
the prepared request to `executePreparedRequest()`. It sends that exact request
without probing the merchant again.

```ts
if (prepared.kind === 'ready' && prepared.nextAction === 'execute') {
  const result = await client.executePreparedRequest(prepared, {
    description: 'generate a staged research brief',
    idempotencyKey: 'execute-prepared-solana-devnet-brief',
  });

  console.log(result.response.status);
}
```

Any other preparation result is not necessarily an error. It means this exact
request does not currently resolve to a payable path.

## Interpreting Merchant Responses

The SDK standardizes payment metadata, not merchant content. The SDK result
carries payment metadata such as `receiptId` and `receipt`. `result.response`
carries the merchant's fulfillment payload, and the merchant's contract decides
where the useful content lives in that payload.

For request-shape guidance before execution, inspect the preparation result:

1. `prepared.hints`: authoritative request fields, examples, notes, and query or body guidance, when the challenge publishes them
2. `prepared.challengeDetails`: raw merchant challenge data, such as accepted payment candidates and extensions
3. any `externalMetadata` you supplied: advisory context only

If you lack the contract information to interpret a merchant response safely,
return the raw merchant body and say what is missing. Do not guess the payload
shape.

## Delegated Execution With Third-Party Payers

`executePreparedRequest()` can hand the final paid merchant call to an executor
that you supply. The control plane still authorizes the attempt and finalizes
the result, so policy, receipts, and outcome normalization stay governed. This
keeps provider code for Dexter, pay.sh, or your own executor out of the core SDK.

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

The delegated flow:

1. The SDK asks the control plane for delegated authorization.
2. If authorized, the SDK calls your executor.
3. Your executor makes the provider-specific paid request and returns a normalized result.
4. The SDK finalizes that result with the control plane.
5. The SDK returns the same `PaidResponse`, or throws the same `FetchPaidError`, as the native path.

The official adapters are published as `@402flow/sdk-third-party-executors`,
with source in `third-party-executors/`. Import only the provider subpath you
use:

```ts
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

## Result And Receipt Semantics

`fetchPaid()` and `executePreparedRequest()` do one of three things:

1. return a passthrough response when the request did not require payment
2. return success with a receipt when the paid request completed
3. throw `FetchPaidError` for every other paid outcome

`FetchPaidError.kind` is one of `denied`, `preflight_failed`,
`execution_pending`, `execution_failed`, `paid_fulfillment_failed`,
`execution_inconclusive`, or `request_failed`.

Receipt status:

- `confirmed`: the control plane has attributed the paid attempt to on-chain settlement.
- `provisional`: merchant-provided evidence supports the paid outcome, but settlement attribution is awaiting reconciliation. Treat it as evidence of a payment attempt, not proof of final settlement.

`idempotencyKey` is optional, but set it whenever a caller or automation loop
might retry.

The [compatibility guide](compatibility.md) has the full taxonomy and retry
rules. In short:

1. retry uncertain operations with the same idempotency key
2. do not retry `paid_fulfillment_failed` as a new payment
3. reconcile `execution_pending` and `execution_inconclusive` before acting again
4. probe aborts and timeouts are platform errors, not `FetchPaidError`

Strict runnable examples are in [`examples/typescript/`](../examples/typescript/).

## Receipt Lookup

```ts
const receipt = await client.lookupReceipt('receipt-id');

console.log(receipt.receipt.status);
```

## Canonical Host Metadata

If you build a tool host, do not copy the orchestration rules into your own
prompts. Import the SDK's host-agnostic metadata and adapt it to your model
provider.

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
- [Compatibility, errors, and safe retries](compatibility.md)
- [Evaluation harness](evaluation-harness.md)
- [Harness scenarios](harness-scenarios.md)
- [Third-party executors](../third-party-executors/README.md)
- [Releasing](releasing.md)
