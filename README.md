# @402flow/sdk

Paid API SDK for AI agents, tool hosts, and governed automation.

It gives AI agents, tool hosts, and automation services easy access to paid APIs while organizations keep policy, approvals, receipts, and spend controls outside the agent runtime.

Use `fetchPaid(...)` when the exact request is already known.
Use `preparePaidRequest(...)` when the agent needs merchant-published hints and an authoritative `nextAction` before paying.

## Why This SDK

- Inspectable paid request flow. Agents and tool hosts can prepare, revise, and execute paid HTTP requests explicitly instead of hiding everything inside one opaque pay-and-fetch call.
- Control-plane governance. Policy, approvals, receipts, and audit stay centralized instead of being reimplemented in every host.
- Agent-ready request shaping. `nextAction` gives models and tools a stable contract for revise, execute, or passthrough.
- Provider-neutral execution. Use the native SDK path or delegate the paid call to Dexter, pay.sh, or a host-owned executor without losing governance value.

## Install

```bash
npm install @402flow/sdk
```

This is the normal install path. Use `@402flow/sdk` by itself when you want the native 402flow payment flow.

Optional official adapters for third-party payers:

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

Install `@402flow/sdk-third-party-executors` only when you want delegated execution through Dexter or pay.sh instead of the native 402flow path.

The published package supports Node 20+.

## Core Surface

| API | Use it when | What it returns |
| --- | --- | --- |
| `fetchPaid(...)` | You already know the request shape | Probe the merchant when no challenge is supplied, then authorize, pay, and return the merchant response |
| `preparePaidRequest(...)` | You want to inspect before paying | Payment terms, parameter hints, validation issues, and an authoritative `nextAction` |
| `executePreparedRequest(...)` | You already prepared the request | Executes the exact prepared request without re-probing first |
| `AgentHarness` | Your model host wants a `preparedId` tool contract | The same flow behind a process-local in-memory three-tool surface |

## Hosted Integration Targets

The hosted demo merchant exposes side-effect-free unpaid probes on two test
networks:

| Network | URL |
| --- | --- |
| Base Sepolia | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia` |
| Solana devnet | `https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet` |

Both routes accept the JSON body used below and return HTTP 402 before payment.
Each paid call costs 0.001 test USDC. Do not substitute a mainnet route unless
you intend to spend real funds.

Run the unpaid hosted contract check with:

```bash
npm run smoke:hosted-demo
```

## Quick Start: Host-Controlled Request

This first example shows the deterministic application path. Your code already knows which merchant route and request parameters it wants to send, and the SDK handles probing, policy, payment, and receipts around that request.

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

This is why the request body is filled in directly in code here. `fetchPaid(...)` is the simplest integration path when your application already knows the parameters.

Important probe semantics: when you do not supply a merchant challenge, both `fetchPaid(...)` and `preparePaidRequest(...)` send the original request to the merchant first to discover whether payment is required. That initial merchant probe happens before any control-plane authorization or payment attempt. For non-idempotent `POST` routes, use this only against endpoints that are explicitly safe to probe or after you already have the merchant challenge from another step.

Use `fetchPaid(...)` when the request is already shaped and you want the shortest path.
Use `preparePaidRequest(...)` when the caller needs to inspect what the merchant published, construct the right request, and execute only when `nextAction === 'execute'`.

The strict, runnable version of this example is
[`examples/typescript/fetch-paid.ts`](examples/typescript/fetch-paid.ts). It
includes passthrough narrowing, typed failures, and an explicit idempotency key.

## Quick Start: Agent-Driven Request Construction

If you want the agent to decide which parameters to send, do not hardcode those decisions into the SDK call site. Instead, expose the SDK through `AgentHarness` or your own tool wrapper and let the agent react to `nextAction`, `validationIssues`, and `hints`.

The typical loop is:

1. the agent proposes a request
2. the SDK returns `nextAction`, `validationIssues`, and merchant-published `hints`
3. the agent revises the request until `nextAction === 'execute'`
4. the host executes the prepared request and reads the stored result before summarizing the outcome

That is the path to use when the model is supposed to fill request parameters properly instead of relying on host code that already knows the answer.

See
[`examples/typescript/prepare-execute.ts`](examples/typescript/prepare-execute.ts)
for a strict executable example.

## AgentHarness

`AgentHarness` is the optional model-host wrapper for the same inspect-then-execute loop.

It stores process-local in-memory prepared state behind a `preparedId`, exposes a canonical three-tool contract, and keeps the rule that matters most stable across hosts:

`nextAction` is authoritative.

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

Use this path when you want the model to construct a correct request instead of guessing its way into a paid call.

`AgentHarness` is a convenience wrapper for single-process hosts. It is not a durable cross-process orchestration store.

## Governed Third-Party Execution

402flow can execute paid x402 requests natively, or you can delegate final payment execution to Dexter, pay.sh, or another executor. Once a payable challenge is already known, 402flow authorizes the paid attempt before execution and finalizes the normalized result afterward, keeping policy, approvals, receipts, and audit centralized.

Official adapters live in `@402flow/sdk-third-party-executors`, and the repo-local source for those adapters lives under `third-party-executors/`. Import the provider-specific subpath you actually use:

```ts
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

The constructors require provider credentials:

- Dexter: `{ wallets, payAndFetchOptions? }`
- pay.sh: `{ signer, rpcUrl?, networks?, policies? }`

Read the [adapter guide](third-party-executors/README.md) before installing the
optional package. It documents the provider dependency footprint and links to
complete executable examples.

## Errors, Retries, And Timeouts

Paid non-success outcomes throw `FetchPaidError`. Merchant probe aborts,
runtime-token failures, and control-plane transport failures are ordinary
platform errors. Always narrow `PaidResponse` before reading receipt fields.

Use an idempotency key for every operation that might be retried. Reuse a key
only for the exact same business operation and request. A timeout does not prove
that payment did not happen.

See the [compatibility guide](docs/compatibility.md) for the complete error
taxonomy and safe-retry table. To bound each network call, use the custom-fetch
pattern in
[`examples/typescript/timeout-client.ts`](examples/typescript/timeout-client.ts).

## Further Reading

- [Detailed SDK guide](docs/sdk-guide.md)
- [Clean-room integration review](docs/clean-room-integration-review.md)
- [Compatibility, errors, and safe retries](docs/compatibility.md)
- [Evaluation harness](docs/evaluation-harness.md)
- [Harness scenarios](docs/harness-scenarios.md)
- [Dexter and pay.sh executors](third-party-executors/README.md)
- [Publishing and release checks](docs/releasing.md)