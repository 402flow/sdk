# @402flow/sdk-third-party-executors

Official supported delegated-execution adapters for `@402flow/sdk`.

This package is intentionally separate from the main `@402flow/sdk` package so the core SDK stays provider-neutral while officially supported provider adapters can evolve on their own dependency surface.

Current scope:

1. Dexter delegated-execution adapter
2. pay.sh x402 Solana exact delegated-execution adapter

## Install

Install this package alongside the matching `@402flow/sdk` version.

```bash
npm install @402flow/sdk @402flow/sdk-third-party-executors
```

If you pin versions explicitly, pin both packages to the same version:

```bash
npm install @402flow/sdk@<version> @402flow/sdk-third-party-executors@<version>
```

This adapter package is versioned and supported in lockstep with `@402flow/sdk`, so keep the two package versions aligned.

## Usage

```ts
import { AgentPayClient } from '@402flow/sdk';
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
// or:
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

Prefer the provider-specific subpath you actually use. That keeps one adapter's
dependency chain out of the other adapter's import path.

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