# @402flow/sdk

[![npm: @402flow/sdk](https://img.shields.io/npm/v/@402flow/sdk?label=%40402flow%2Fsdk)](https://www.npmjs.com/package/@402flow/sdk)
[![npm: third-party executors](https://img.shields.io/npm/v/@402flow/sdk-third-party-executors?label=third-party-executors)](https://www.npmjs.com/package/@402flow/sdk-third-party-executors)

Paid API SDK for AI agents, tool hosts, and governed automation. Your code calls
paid HTTP APIs, while policy, approvals, receipts, and spend controls stay in the
402flow control plane, outside the agent runtime.

Use `fetchPaid()` when you already know the exact request.
Use `preparePaidRequest()` when an agent needs merchant-published hints and an
authoritative `nextAction` before paying.

## Why This SDK

- Inspectable flow. Agents and tool hosts can prepare, revise, and execute a paid request as separate steps, or use one call when the request is already known.
- Central governance. Policy, approvals, receipts, and audit live in the control plane, so each host does not reimplement them.
- Agent-ready request shaping. `nextAction` tells a model or tool whether to revise the request, execute it, or treat it as passthrough.
- Provider-neutral execution. Pay natively, or delegate the paid call to Dexter, pay.sh, or your own executor. The control plane still authorizes and records it.

## Install

```bash
npm install @402flow/sdk
```

The SDK requires Node 20 or newer.

To delegate payment to Dexter or pay.sh, also install the optional adapter package:

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

## Core Surface

| API | Use it when | What it does |
| --- | --- | --- |
| `fetchPaid()` | You already know the request | Probes the merchant if you supply no challenge, then authorizes, pays, and returns the merchant response |
| `preparePaidRequest()` | You want to inspect before paying | Returns payment terms, parameter hints, validation issues, and an authoritative `nextAction` |
| `executePreparedRequest()` | You already prepared the request | Pays for the exact prepared request without probing the merchant again |
| `AgentHarness` | A model host needs a tool contract keyed by `preparedId` | Exposes the same flow as three tools, with state held in process memory |

## Hosted Integration Targets

The hosted demo merchant serves the same research-brief route on four networks:

| Network | Environment | URL | Price per paid call |
| --- | --- | --- | --- |
| Base Sepolia | Testnet | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia` | 0.001 test USDC |
| Base | Mainnet | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-mainnet` | 0.001 real USDC |
| Solana devnet | Testnet | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet` | 0.001 test USDC |
| Solana | Mainnet | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-mainnet` | 0.001 real USDC |

Each route accepts the JSON body shown below and returns HTTP 402 before
payment. To check all four challenges without paying, run:

```bash
npm run smoke:hosted-demo
```

The release integration campaign is `npm run scenario:core`. It makes 12 paid
requests: six on testnets and three each on Base and Solana mainnet. At the
current price, mainnet merchant spend is 0.006 USDC in total, plus network fees.
It requires funded Base and Solana mainnet rails. The campaign is incomplete if
either mainnet cannot authorize, pay, and return HTTP 200 content with a
receipt. See the [scenario guide](docs/harness-scenarios.md).

## Quick Start: Host-Controlled Request

Use this path when your code already knows the merchant route and request body.
The SDK probes the merchant, gets a control-plane decision, pays, and returns the
receipt.

```ts
import {
  AgentPayClient,
  createJsonRequestBody,
} from '@402flow/sdk';

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
    idempotencyKey: 'sdk-readme-solana-devnet-brief',
  },
);

console.log(await result.response.json());
if (result.kind === 'success') {
  console.log(result.receiptId);
}
```

When you do not supply a merchant challenge, `fetchPaid()` and
`preparePaidRequest()` first send the original request to the merchant to see
whether payment is required. This probe happens before any control-plane
authorization or payment. For non-idempotent `POST` routes, probe only endpoints
that are safe to probe, or pass a challenge you already have.

[`examples/typescript/fetch-paid.ts`](examples/typescript/fetch-paid.ts) is the
strict, runnable version of this example. It includes passthrough narrowing,
typed failures, and an explicit idempotency key.

## Quick Start: Agent-Driven Request Construction

When the agent should choose the request parameters, do not hardcode them at the
call site. Expose the SDK through `AgentHarness` or your own tool wrapper, and
let the agent respond to `nextAction`, `validationIssues`, and `hints`:

1. The agent proposes a request.
2. The SDK returns `nextAction`, `validationIssues`, and merchant-published `hints`.
3. The agent revises the request until `nextAction === 'execute'`.
4. The host executes the prepared request, then reads the stored result before summarizing the outcome.

See
[`examples/typescript/prepare-execute.ts`](examples/typescript/prepare-execute.ts)
for a strict runnable example.

## AgentHarness

`AgentHarness` is an optional wrapper for model hosts. It keeps prepared requests
in process memory behind a short `preparedId` and exposes a standard three-tool
contract. On every host, `nextAction` is authoritative: the model executes a
request only when `nextAction` is `execute`.

```ts
import {
  AgentHarness,
  defaultHarnessInstructions,
  defaultHarnessToolSpecs,
} from '@402flow/sdk';

const harness = new AgentHarness({ client });

console.log(defaultHarnessInstructions);
console.log(defaultHarnessToolSpecs.map((spec) => spec.name));
// [ 'prepare_paid_request', 'execute_prepared_request', 'get_execution_result' ]
```

`AgentHarness` suits single-process hosts. It is not a durable store and does
not share state across processes.

## Governed Third-Party Execution

402flow can pay x402 requests natively, or you can delegate the final paid call to
Dexter, pay.sh, or your own executor. Once the challenge is known, the control
plane authorizes the attempt before execution and finalizes the normalized result
afterward. Policy, approvals, receipts, and audit stay in one place.

The official adapters are published as `@402flow/sdk-third-party-executors`, with
source in `third-party-executors/`. Import only the provider subpath you use:

```ts
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

Dexter needs `wallets`, and pay.sh needs a Solana `signer`. Read the
[adapter guide](third-party-executors/README.md) before installing: it lists the
optional settings and the provider dependency footprint, and links to complete
examples.

## Errors, Retries, And Timeouts

Paid non-success outcomes throw `FetchPaidError`. Merchant probe aborts,
runtime-token failures, and control-plane transport failures throw ordinary
platform errors. Narrow `PaidResponse` on `kind` before reading receipt fields.

Set an idempotency key on any operation you might retry, and reuse it only for
the exact same business operation and request. A timeout does not prove that no
payment happened.

The [compatibility guide](docs/compatibility.md) has the full error taxonomy and
retry table. To bound each network call, use the custom `fetch` in
[`examples/typescript/timeout-client.ts`](examples/typescript/timeout-client.ts).

## Further Reading

- [Detailed SDK guide](docs/sdk-guide.md)
- [Clean-room integration review](docs/clean-room-integration-review.md)
- [Compatibility, errors, and safe retries](docs/compatibility.md)
- [Evaluation harness](docs/evaluation-harness.md)
- [Harness scenarios](docs/harness-scenarios.md)
- [Dexter and pay.sh executors](third-party-executors/README.md)
- [Publishing and release checks](docs/releasing.md)