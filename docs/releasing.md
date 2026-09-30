# Releasing

This guide covers release checks and publish order for `@402flow/sdk` and
`@402flow/sdk-third-party-executors`. Both packages share one version, and the
adapter's peer dependency pins that exact SDK version.

## Checks

From the SDK root:

```bash
npm run install:all
npm run check:all
npm run pack:check
npm --prefix third-party-executors run pack:check
npm run smoke:hosted-demo
```

`check:all` lints, typechecks, and tests the core SDK, then the adapter package.
The pack checks build each package and run `npm pack --dry-run`. SDK CI also
installs both packed tarballs, imports them, and compiles the TypeScript
examples against them; confirm that CI passed for the release commit.

`smoke:hosted-demo` makes unpaid probes against the Base Sepolia, Base mainnet,
Solana devnet, and Solana mainnet demo routes. Do not publish customer-facing
demo URLs while this check fails.

## Release Campaign

`npm run scenario:core` is the release integration gate. See
[the scenario guide](harness-scenarios.md#release-campaign) for prerequisites and
required evidence.

The campaign clears `tmp/`, so preserve any hosted probe reports and recovery
checkpoints first. It makes paid requests, including three on Base mainnet and
three on Solana mainnet, so obtain payment authorization before running it. Use a
control plane that accepts the candidate SDK version. Both mainnet rails must
pass; local tests and unpaid probes do not replace this campaign.

## Publish Order

Publish the core SDK first. Publish the adapter package after the matching SDK
version is available on npm.

From the SDK root:

```bash
npm publish --access public
```

From `third-party-executors/`:

```bash
npm publish --access public
```

Each package's `prepublishOnly` hook reruns its checks: `npm run check:all` for
the core SDK and `npm run check` for the adapter.

## Related Docs

- [Root README](../README.md)
- [SDK guide](sdk-guide.md)
- [Third-party executors](../third-party-executors/README.md)
