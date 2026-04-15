# Harness Scenarios

This document collects the example harness scenarios, recommended preset pairings, and the heavier local and public evaluation notes that do not belong in the package README.

## Named Scenario Fixture Packs

Current named scenarios:

1. `image-ready`: paid image generation request that is already executable without revision
2. `image-revise`: paid image generation request that should trigger `revise_request` until the `style` field is added
3. `nickeljoke-compat`: public compatibility merchant at `https://nickeljoke.vercel.app/api/joke`, with `POST` as part of the contract
4. `nickeljoke-reasoning-revise`: Nickeljoke scenario that starts incomplete and relies on external metadata for one revision
5. `auor-public-holidays-reasoning-revise`: GET scenario that derives required query params from merchant hints
6. `quicknode-solana-devnet-bazaar-revise`: external x402 scenario for `https://x402.quicknode.com/solana-devnet` that starts with an incomplete JSON-RPC body and relies on merchant challenge hints for revision
7. `solana-devnet-research-brief-ready`: canonical local agentic scenario against the self-hosted Solana devnet merchant research brief route with a complete shaped body ready for execution
8. `solana-devnet-research-brief-revise`: canonical local agentic scenario against the same route, starting incomplete to exercise revision
9. `x402-org-protected-ready`: external x402 compatibility scenario for `https://x402.org/protected` that is ready to execute without revision

## Recommended Preset Pairings

Recommended pairings:

1. `image-ready` -> `ready-json-post`
2. `image-revise` -> `revise-json-post`
3. `nickeljoke-compat` -> `ready-json-post`
4. `nickeljoke-reasoning-revise` -> `revise-json-post`
5. `auor-public-holidays-reasoning-revise` -> `revise-get-query`
6. `quicknode-solana-devnet-bazaar-revise` -> `revise-json-post`
7. `solana-devnet-research-brief-ready` -> `ready-json-post`
8. `solana-devnet-research-brief-revise` -> `revise-json-post`
9. `x402-org-protected-ready` -> `ready-json-post`

## Canonical Local Agentic Path

The first product-representative local scenario is the self-hosted Solana devnet merchant research brief route:

```text
http://127.0.0.1:4123/paid/solana-devnet/research-brief
```

This is the canonical local path when request shaping should matter in a real agent loop.

Prerequisites:

1. local agent-pay infrastructure is running
2. the local API is running, for example at `http://localhost:3001`
3. the self-hosted Solana merchant is running via `pnpm merchant:solana`
4. a local org and agent exist and can authenticate through the SDK
5. one Solana devnet execution rail is enabled for that org
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
  --transcript-file ./tmp/solana-devnet-research-brief-revise-run.json
```

Expected outcomes:

1. `prepare_paid_request` may return `nextAction: revise_request` when preparation emits `validationIssues`
2. if no `validationIssues` are emitted, preparation can still return `nextAction: execute` even with an incomplete task-specific body
3. in that case, merchant-side validation may still reject paid execution with `422`
4. `get_execution_result` still returns the deterministic stored result for the prepared request

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