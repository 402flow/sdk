# Publishing

This guide covers release checks and publish order for `@402flow/sdk` and `@402flow/sdk-third-party-executors`.

## Repo-Wide Verification

From the SDK root:

```bash
npm run install:all
npm run check:all
npm run smoke:hosted-demo
npm run pack:check
```

`npm run check:all` validates the main SDK package first and then the separate `third-party-executors` package.

`npm run smoke:hosted-demo` makes unpaid probes against the public Base Sepolia,
Base mainnet, Solana devnet, and Solana mainnet routes. Do not publish
customer-facing demo URLs while this check fails.

Also run `npm --prefix third-party-executors run pack:check` and verify installed
tarball imports and consumer TypeScript compilation, as covered by SDK CI.

The release integration gate is `npm run scenario:core`; see
[the scenario campaign](harness-scenarios.md) for prerequisites and required
evidence. This command clears `tmp/`, so preserve any hosted probe reports and
recovery checkpoints first. It includes three paid Base mainnet and three paid
Solana mainnet requests. Obtain payment authorization before running it, and
use a control plane that accepts the candidate SDK version. Both rails must
pass; local tests and unpaid probes do not replace this campaign.

## Publish Order

Publish the main SDK package first.
Publish `@402flow/sdk-third-party-executors` second, after the matching SDK version is available.

### Main SDK Package

From the SDK root:

```bash
npm run install:all
npm run check:all
npm run pack:check
npm publish --access public
```

`npm publish` also runs `npm run check:all` through the root `prepublishOnly` hook.

### Adapter Package

From `third-party-executors/`:

```bash
npm install
npm run check
npm run pack:check
npm publish --access public
```

Keep the main SDK package version and the adapter package version aligned.

## Related Docs

- [Root README](../README.md)
- [SDK guide](sdk-guide.md)
- [Third-party executors](../third-party-executors/README.md)
