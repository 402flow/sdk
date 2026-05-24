## Test Folder Purpose

This folder is reserved for cross-module and integration-like SDK tests.

Use `test/` for specs that exercise one or more of these boundaries:

1. public package entrypoints and exports
2. multi-module SDK flows
3. dev-only support code such as `dev-support/`
4. broader request or execution scenarios that are not naturally owned by one source file

Examples in this folder:

1. `public-api.test.ts` checks the published package surface
2. `index.test.ts` covers broader `AgentPayClient` behavior across multiple modules
3. `agent-harness.test.ts` exercises the harness across its stored preparation and execution flow
4. `dexter-executor.test.ts` covers the shared dev-only Dexter adapter

## Unit Test Placement

Keep unit tests next to the source file they primarily verify.

Use colocated `src/*.test.ts` files when the test is mostly about one module's local behavior, parsing rules, or helper logic.

Example:

1. `src/challenge-detection.test.ts` stays next to `src/challenge-detection.ts` because it is a tight module-level test

## Rule Of Thumb

If a test would still make sense after replacing its imports with a single nearby source file, keep it in `src/` next to that file.

If a test is primarily about interactions across modules, package exports, or dev-only integration helpers, put it in `test/`.