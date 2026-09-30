# @402flow/sdk-third-party-executors

Official delegated-execution adapters for `@402flow/sdk`:

1. Dexter
2. pay.sh, for the x402 `exact` scheme on Solana

The adapters ship separately so the core SDK stays provider-neutral and the
provider dependencies can change on their own schedule.

## Install

This package requires Node 20.18 or newer because of its Solana dependencies.
It is versioned in lockstep with `@402flow/sdk`, and its peer dependency pins the
exact matching SDK version. Install both together:

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

If you pin versions, pin both packages to the same version:

```bash
npm install @402flow/sdk@<version> @402flow/sdk-third-party-executors@<version>
```

## Choose A Provider

```ts
import { AgentPayClient } from '@402flow/sdk';
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

Import the provider-specific subpath you use. The other adapter then does not
load at runtime, and bundlers can exclude it. npm still installs both providers'
dependencies, because this combined package declares both.

Constructor options:

| Provider | Required | Optional |
| --- | --- | --- |
| Dexter | `wallets` from `@dexterai/x402/client` | `payAndFetchOptions` |
| pay.sh | a Solana `signer` accepted by `@x402/svm` | `fetch`, `networks`, `paymentRequirementsSelector`, `policies`, `rpcUrl`, `x402HttpClient` |

Pass the adapter to `executePreparedRequest()`:

```ts
const prepared = await client.preparePaidRequest(url, requestInit);

if (prepared.kind === 'ready' && prepared.nextAction === 'execute') {
  const result = await client.executePreparedRequest(prepared, {
    description: 'execute through Dexter',
    idempotencyKey: businessOperationId,
    executionProvider: 'dexter',
    executor: createDexterExecutor({
      wallets: { evm: dexterWallet },
    }),
  });

  console.log(result.response.status);
}
```

Complete runnable examples:

1. [`examples/dexter-delegated-executor.mjs`](examples/dexter-delegated-executor.mjs)
2. [`examples/pay-sh-delegated-executor.mjs`](examples/pay-sh-delegated-executor.mjs)

Both examples need 402flow credentials and provider signing credentials. Run
either command with `--help` before you submit a paid request.

### Dexter Network Boundary

`@dexterai/x402` 5.4.2 resolves Base and Solana mainnet, but not Base Sepolia or
Solana devnet. The hosted demo test routes therefore validate the native 402flow
SDK flow but cannot validate a Dexter settlement. Against either test route,
Dexter returns `no_payment_options` before wallet signing, and this adapter
normalizes that to a typed `preflight_failed` result.

A full Dexter settlement needs a supported network and a funded wallet. Do not
move an integration test to mainnet only to get around the testnet limitation;
use an intentional, spend-capped verification plan.

## Dependency Footprint

The core `@402flow/sdk` package depends only on Zod. This adapter package
installs both provider stacks. It pins `@dexterai/x402` exactly because Dexter's
payment and result contracts are part of the adapter's tested runtime boundary.

Dexter 5.4.2 pulls in a legacy Solana dependency path even when your Dexter
wallet is EVM-only. `npm audit --omit=dev` reports the `bigint-buffer` advisory
through `@solana/spl-token` and `@dexterai/vault`, with no upstream fix
available. Review that advisory against your deployment and threat model. Do not
force transitive cryptography or Solana overrides.

A future breaking release may split the providers into separate packages or make
their SDKs optional peer dependencies. That change cannot ship in a patch
release, because it changes installation and runtime resolution.

## Ownership

The core `@402flow/sdk` package owns:

1. the public executor contract
2. delegated authorization and finalization
3. normalization of results to `PaidResponse` or `FetchPaidError`

This package owns:

1. the provider-specific adapter implementations
2. provider-specific proof tests
3. the examples under `third-party-executors/examples/`

## In-Repo Verification

From `third-party-executors/`:

1. `npm run check`
2. `npm run pack:check`
3. `npm run example:dexter-delegated-executor -- --help`
4. `npm run example:pay-sh-delegated-executor -- --help`

From the SDK root, `npm run check:all` checks both the core SDK and this package.

## Release Order

Publish the matching `@402flow/sdk` version first, then this package.