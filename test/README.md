## Test Folder Purpose

This folder is reserved for cross-module and integration-like SDK tests.

Use `test/` for specs that exercise one or more of these boundaries:

1. public package entrypoints and exports
2. multi-module SDK flows
3. broader request or execution scenarios that are not naturally owned by one source file

Third-party executor proof packages maintain their own tests outside this folder.

Examples in this folder:

1. `public-api.test.ts` checks the published package surface
2. `agent-pay-client.integration.test.ts` covers broader `AgentPayClient` behavior across multiple modules
3. `agent-harness.integration.test.ts` exercises SDK-backed harness preparation and execution flows

## Unit Test Placement

Keep unit tests next to the source file they primarily verify.

Use colocated `src/*.test.ts` files when the test is mostly about one module's local behavior, parsing rules, or helper logic.

Example:

1. `src/challenge-detection.test.ts` stays next to `src/challenge-detection.ts` because it is a tight module-level test
2. `src/index.test.ts` stays next to `src/index.ts` for entrypoint-local client behavior such as challenge forwarding, request hashing, and runtime-token handling
3. `src/agent-harness.test.ts` stays next to `src/agent-harness.ts` for harness-local state transitions, rejection rules, and cost-summary formatting

## Rule Of Thumb

If a test would still make sense after replacing its imports with a single nearby source file, keep it in `src/` next to that file.

If a test is primarily about interactions across modules or package exports, put it in `test/`.

If a test is primarily about a separate third-party executor package such as `third-party-executors/`, keep it with that package instead of the main SDK test folder.