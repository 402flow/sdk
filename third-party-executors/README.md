# @402flow/sdk-third-party-executors

Official supported delegated-execution adapters for `@402flow/sdk`.

This package is intentionally separate from the main `@402flow/sdk` package so the core SDK stays provider-neutral while officially supported provider adapters can evolve on their own dependency surface.

Current scope:

1. Dexter delegated-execution adapter
2. pay.sh x402 Solana exact delegated-execution adapter

## Install

This adapter package requires Node 20.18 or newer because of its Solana
dependency surface.

Install this package alongside the matching `@402flow/sdk` version.

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

If you pin versions explicitly, pin both packages to the same version:

```bash
npm install @402flow/sdk@<version> @402flow/sdk-third-party-executors@<version>
```

This adapter package is versioned and supported in lockstep with `@402flow/sdk`, so keep the two package versions aligned.

## Choose A Provider

```ts
import { AgentPayClient } from '@402flow/sdk';
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

Prefer the provider-specific subpath you use. This prevents the other adapter
from loading at runtime and lets bundlers exclude it. It does not change what
npm installs: this combined package currently declares both provider dependency
trees.

Constructor options:

| Provider | Required | Optional |
| --- | --- | --- |
| Dexter | `wallets` from `@dexterai/x402/client` | `payAndFetchOptions` |
| pay.sh | a Solana `signer` accepted by `@x402/svm` | `fetch`, `networks`, `paymentRequirementsSelector`, `policies`, `rpcUrl`, `x402HttpClient` |

Pass the selected adapter to the prepared execution call:

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

Complete executable examples:

1. [`examples/dexter-delegated-executor.mjs`](examples/dexter-delegated-executor.mjs)
2. [`examples/pay-sh-delegated-executor.mjs`](examples/pay-sh-delegated-executor.mjs)

Both examples require 402flow credentials and provider signing credentials.
Run either command with `--help` before submitting a paid request.

## Dependency Footprint

The core `@402flow/sdk` package depends only on Zod. The optional combined
adapter package installs both provider stacks. The package pins
`@dexterai/x402` because its payment and result contracts are part of this
adapter's tested runtime boundary.

Dexter 5.4.2 currently brings a legacy Solana dependency path even when your
Dexter wallet is EVM-only. `npm audit --omit=dev` reports the
`bigint-buffer` advisory through `@solana/spl-token` and `@dexterai/vault`,
with no upstream fix available. Review that advisory against your deployment
and threat model. Do not force transitive cryptography or Solana overrides.

A future breaking release can split provider packages or move provider SDKs to
optional peer dependencies. That change must not be made in a patch release
because it changes installation and runtime resolution behavior.

The main SDK package owns:

1. the public executor contract
2. delegated authorization and finalization
3. outward result normalization to `PaidResponse` or `FetchPaidError`

This package owns:

1. provider-specific adapter implementations
2. provider-specific proof tests
3. source-level examples in this repo under `third-party-executors/examples/`

## In-Repo Verification

If you are working in this repo, useful commands are:

1. `npm run check`
2. `npm run pack:check`
3. `npm run example:dexter-delegated-executor -- --help`
4. `npm run example:pay-sh-delegated-executor -- --help`

From the SDK root, you can also run `npm run check:all` to validate both the main SDK package and this package in one pass.

## Release Order

When publishing from this repo, publish the main `@402flow/sdk` package first, then publish `@402flow/sdk-third-party-executors` after the matching SDK version is available.