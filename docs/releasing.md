# Publishing

This guide covers release checks and publish order for `@402flow/sdk` and `@402flow/sdk-third-party-executors`.

## Repo-Wide Verification

From the SDK root:

```bash
npm run install:all
npm run check:all
npm run pack:check
```

`npm run check:all` validates the main SDK package first and then the separate `third-party-executors` package.

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