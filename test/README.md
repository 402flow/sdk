# SDK Tests

This folder holds cross-module and integration-style SDK tests: specs that
exercise one or more of these boundaries:

1. public package entrypoints and exports
2. multi-module SDK flows
3. broader request or execution scenarios that no single source file owns

Examples:

1. `public-api.test.ts` checks the published package surface
2. `agent-pay-client.integration.test.ts` covers broader `AgentPayClient` behavior across modules
3. `agent-harness.integration.test.ts` exercises SDK-backed harness preparation and execution

## Unit Test Placement

Keep a unit test next to the source file it mainly verifies. Use a colocated
`src/*.test.ts` file when the test is about one module's local behavior, parsing
rules, or helpers. For example:

1. `src/challenge-detection.test.ts` covers `src/challenge-detection.ts`
2. `src/index.test.ts` covers entrypoint-local client behavior in `src/index.ts`, such as challenge forwarding, request hashing, and runtime-token handling
3. `src/agent-harness.test.ts` covers harness-local state transitions, rejection rules, and cost-summary formatting in `src/agent-harness.ts`

## Rule Of Thumb

If a test would still make sense with its imports replaced by one nearby source
file, keep it in `src/` next to that file. If it is mainly about interactions
across modules or package exports, put it in `test/`.

Tests for the third-party executor package live with that package in
`third-party-executors/`, not here.