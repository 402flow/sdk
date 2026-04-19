# Harness Scenarios

This document collects the example harness scenarios, recommended preset pairings, and the heavier local and public evaluation notes that do not belong in the package README.

## Named Scenario Fixture Packs

Before running SDK examples or scenario sweeps from this repo, create `.env` from `.env.example` in the SDK root. The scenario runner loads SDK-local dotenv files directly.

To rerun the full stable scenario set and replace any older artifacts in `tmp/` with only the newest results, use:

```bash
npm run scenario:all
```

That command clears `tmp/`, rebuilds the SDK, reruns the full scenario plan, and writes only the newest logs, transcripts, and semantic summary back under `tmp/`.

Shell-exported values still win when you need to temporarily point the SDK at a different control plane or auth context.

Current named scenarios:

1. `nickeljoke-compat`: public compatibility merchant at `https://nickeljoke.vercel.app/api/joke`, with `POST` as part of the contract
2. `auor-public-holidays-reasoning-revise`: GET scenario that derives required query params from merchant hints
3. `base-sepolia-research-brief-bazaar-revise`: canonical local Bazaar-driven revise scenario against the self-hosted Base Sepolia merchant research brief route
4. `base-sepolia-research-brief-ready`: canonical local agentic scenario against the same route with a complete shaped body ready for execution
5. `base-sepolia-research-brief-revise`: canonical local agentic scenario against the same route, starting incomplete while also providing advisory external metadata
6. `base-mainnet-research-brief-bazaar-revise`: canonical local Bazaar-driven revise scenario against the self-hosted Base mainnet merchant research brief route
7. `base-mainnet-research-brief-ready`: canonical local agentic scenario against the same route with a complete shaped body ready for execution
8. `base-mainnet-research-brief-revise`: canonical local agentic scenario against the same route, starting incomplete while also providing advisory external metadata
9. `solana-devnet-research-brief-bazaar-revise`: canonical local Bazaar-driven revise scenario against the self-hosted Solana devnet merchant research brief route
10. `solana-devnet-research-brief-ready`: canonical local agentic scenario against the same route with a complete shaped body ready for execution
11. `solana-devnet-research-brief-revise`: canonical local agentic scenario against the same route, starting incomplete while also providing advisory external metadata
12. `solana-mainnet-research-brief-bazaar-revise`: canonical local Bazaar-driven revise scenario against the self-hosted Solana mainnet merchant research brief route
13. `solana-mainnet-research-brief-ready`: canonical local agentic scenario against the same route with a complete shaped body ready for execution
14. `solana-mainnet-research-brief-revise`: canonical local agentic scenario against the same route, starting incomplete while also providing advisory external metadata
15. `x402-org-protected-ready`: external x402 compatibility scenario for `https://x402.org/protected` that is ready to execute without revision
16. `policy-denied-budget-exceeded`: mocked governance scenario that returns a budget-cap denial and expects the final answer to explain the policy block clearly
17. `policy-denied-merchant-not-allowed`: mocked governance scenario that returns a deny-by-default merchant rejection
18. `policy-review-required`: mocked governance scenario that returns a denial with `policyReviewEventId` and expects the final answer to surface the review requirement
19. `execution-failed-merchant-rejected`: mocked governance scenario that returns a post-payment merchant rejection
20. `execution-inconclusive`: mocked governance scenario that returns an honest inconclusive outcome
21. `preflight-failed-no-rail`: mocked governance scenario that returns a missing-payment-rail failure before execution can succeed

## Recommended Preset Pairings

Recommended pairings:

1. `nickeljoke-compat` -> `ready-json-post`
2. `auor-public-holidays-reasoning-revise` -> `revise-get-query`
3. `base-sepolia-research-brief-bazaar-revise` -> `revise-json-post`
4. `base-sepolia-research-brief-ready` -> `ready-json-post`
5. `base-sepolia-research-brief-revise` -> `revise-json-post`
6. `base-mainnet-research-brief-bazaar-revise` -> `revise-json-post`
7. `base-mainnet-research-brief-ready` -> `ready-json-post`
8. `base-mainnet-research-brief-revise` -> `revise-json-post`
9. `solana-devnet-research-brief-bazaar-revise` -> `revise-json-post`
10. `solana-devnet-research-brief-ready` -> `ready-json-post`
11. `solana-devnet-research-brief-revise` -> `revise-json-post`
12. `solana-mainnet-research-brief-bazaar-revise` -> `revise-json-post`
13. `solana-mainnet-research-brief-ready` -> `ready-json-post`
14. `solana-mainnet-research-brief-revise` -> `revise-json-post`
15. `x402-org-protected-ready` -> `ready-json-post`
16. `policy-denied-budget-exceeded` -> `mock-governance`
17. `policy-denied-merchant-not-allowed` -> `mock-governance`
18. `policy-review-required` -> `mock-governance`
19. `execution-failed-merchant-rejected` -> `mock-governance`
20. `execution-inconclusive` -> `mock-governance`
21. `preflight-failed-no-rail` -> `mock-governance`

## Governance Fixtures

The six governance scenarios are fixture-driven and use the mock client path inside the harness example.

That means:

1. they still exercise the normal `prepare_paid_request` -> `execute_prepared_request` -> `get_execution_result` loop
2. they still rely on the same `AgentHarness` summarization path as real executions
3. they do not require a live 402flow API server to produce denials, preflight failures, or inconclusive outcomes

They are useful for checking whether the model reports non-success outcomes honestly instead of defaulting to happy-path language.

## Canonical Local Agentic Path

The first product-representative local scenario is the self-hosted Solana devnet merchant research brief route:

```text
http://127.0.0.1:4123/demo-merchant/research-brief/solana-devnet
```

This is the canonical local path when request shaping should matter in a real agent loop.

The matching local EVM testnet scenario path is:

```text
http://127.0.0.1:4123/demo-merchant/research-brief/base-sepolia
```

The matching local EVM mainnet scenario path is:

```text
http://127.0.0.1:4123/demo-merchant/research-brief/base-mainnet
```

The matching real-money local mainnet scenario path is:

```text
http://127.0.0.1:4123/demo-merchant/research-brief/solana-mainnet
```

Prerequisites:

1. local agent-pay infrastructure is running
2. the local API is running, for example at `http://localhost:3001`
3. the self-hosted demo merchant is running via `pnpm dev:demo-merchant`
4. a local org and agent exist and can authenticate through the SDK
5. one compatible Base or Solana execution rail is enabled for that org, depending on the scenario
6. either `X402FLOW_BOOTSTRAP_KEY` or `X402FLOW_RUNTIME_TOKEN` is set

Example local revise run:

```bash
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="http://localhost:3001"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="x402-demo-agent"
export X402FLOW_BOOTSTRAP_KEY="..."

npm run example:openai-harness -- \
  --preset revise-json-post \
  --scenario solana-devnet-research-brief-revise \
  --transcript-file ./tmp/scenario-runs/solana-devnet-research-brief-revise-run.json
```

Run the scenario sweep from the SDK repo itself. Keep SDK scenario setup and credentials in this repo's `.env` so the examples can point at local `agent-pay` or future public demo merchants without a control-plane wrapper.

Expected outcomes:

1. `prepare_paid_request` should return `nextAction: revise_request` when merchant-published Bazaar metadata shows required request body fields are missing
2. after one revision, the scenario should prepare as `execute`
3. paid execution should return a deterministic JSON body that echoes the accepted brief input and output sections
4. `get_execution_result` should return the same stored result after execution

## Challenge Details Status

Default surface slimming is still deferred.

`hints` is the preferred request-shaping surface, but the current host-facing prepare result still includes `challengeDetails`, and that is intentional while Bazaar revise coverage remains the proof point for whether `challengeDetails.extensions` can be hidden safely.

For now:

1. treat `hints` as the primary revise surface
2. treat `challengeDetails` as still available for richer merchant-published discovery data
3. do not assume the default agent-facing surface has been reduced yet

The same readiness rule applies here as everywhere else:

`ready` means this exact request can proceed through governed paid execution as-is; it does not mean the SDK has inferred the best task parameters for you.

## Public Compatibility Targets

### Nickeljoke

The first concrete public paid endpoint wired into the harness is the Nickeljoke compatibility merchant:

```text
https://nickeljoke.vercel.app/api/joke
```

Important constraint: use `POST`. Compatibility behavior for `GET` can still lead to `405 Method Not Allowed` on the paid retry even if payment proof is accepted.

Prerequisites:

1. a running 402flow control plane, for example local `agent-pay` API at `http://localhost:3001`
2. an active organization and agent that the SDK can authenticate as
3. a merchant record for `https://nickeljoke.vercel.app`
4. a funded Base Sepolia execution rail enabled for that organization
5. either `X402FLOW_BOOTSTRAP_KEY` or `X402FLOW_RUNTIME_TOKEN`

Example live run:

```bash
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="http://localhost:3001"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="x402-demo-agent"
export X402FLOW_BOOTSTRAP_KEY="..."

npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario nickeljoke-compat \
  --transcript-file ./tmp/nickeljoke-live-run.json
```

### x402.org

External paid compatibility run for `https://x402.org/protected`:

```bash
export OPENAI_API_KEY="..."
export X402FLOW_CONTROL_PLANE_BASE_URL="http://localhost:3001"
export X402FLOW_ORGANIZATION="acme-labs"
export X402FLOW_AGENT="x402-demo-agent"
export X402FLOW_BOOTSTRAP_KEY="..."

npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario x402-org-protected-ready \
  --transcript-file ./tmp/x402-org-protected-ready-run.json
```

This is a third-party compatibility target, not the canonical product-representative proving path.

## Scenario Credibility Notes

Scenario packs are useful evaluation fixtures, but they are not the SDK contract.

They will age faster than the core package surface because they depend on:

1. specific merchants
2. local infrastructure assumptions
3. prompt behavior
4. external compatibility endpoints

Use them as smoke-test and evaluation material, not as the primary definition of what `@402flow/sdk` is.