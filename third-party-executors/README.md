# Third-Party Executors

This repo-local package holds third-party executor adapters that are intentionally separate from the main `@402flow/sdk` package.

Current scope:

1. Dexter delegated-execution adapter and proof coverage
2. room for future third-party executors such as pay.sh under the same boundary

## Why This Package Exists

`@402flow/sdk` stays provider-neutral.

Third-party executor adapters belong here when they:

1. depend on external provider SDKs
2. need their own tests or examples
3. should not affect the default dependency or audit surface of the main SDK package

## Boundary

The main SDK package owns:

1. the public executor contract
2. delegated authorization and finalization
3. outward result normalization to `PaidResponse` or `FetchPaidError`

This package owns:

1. provider-specific adapter implementations
2. provider-specific proof tests
3. repo-local examples that exercise those adapters

## Install And Use

```bash
cd third-party-executors
npm install
```

Useful commands:

1. `npm run check`
2. `npm run example:dexter-delegated-executor -- --help`

From the SDK root, you can also run `npm run check:all` to validate both the main SDK package and this package in one pass.

## Rule Of Thumb

If code belongs to the published provider-neutral SDK, keep it in the main package `src/`.

If code exists to adapt or prove a specific third-party executor such as Dexter or pay.sh, keep it in this package.