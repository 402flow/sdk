## Dev Support Purpose

This folder holds shared dev-only helpers.

Use `dev-support/` for code that is intentionally outside the published `@402flow/sdk` runtime API but still needs one local source of truth across repo-only consumers such as:

1. tests
2. examples
3. local proving or scenario utilities

Current example:

1. `dexter-executor.ts` is the shared Dexter delegated-execution adapter used by tests and the repo-local example

## What Belongs Here

Put code in `dev-support/` when all of these are true:

1. it is not part of the public SDK surface
2. it is useful in more than one dev-only place
3. it may depend on third-party SDKs that should not become runtime dependencies of `@402flow/sdk`
4. it should stay type-aligned with the SDK contracts in `src/`

If a helper is only used by one test file, keep it with that test instead.

If code belongs to the published SDK runtime, it must live in `src/`, not here.

## Build And Publication Boundary

`dev-support/` is linted and typechecked in this repo, but it is not part of the package exports and is not published with the package tarball.

The repo-local Dexter example compiles this folder with `npm run build:dev-support` before importing the generated output.

That split is intentional:

1. tests can import the TypeScript source directly from `dev-support/`
2. examples can reuse the same logic through compiled local output
3. package consumers do not receive or depend on this folder

## Rule Of Thumb

`src/` is for published SDK code.

`test/` is for cross-module and integration-like specs.

`dev-support/` is for shared dev-only implementation helpers used by those specs or repo-local examples.