# Harness Scenarios

This guide covers the example scenario packs, the release campaign, and the live
compatibility targets for the [evaluation runner](evaluation-harness.md).

Scenario packs are evaluation fixtures, not the SDK contract. They depend on
specific merchants, infrastructure, prompt behavior, and external endpoints, so
they change faster than the package API.

## Setup

Create `.env` from `.env.example` in the SDK root. The runner loads SDK-local env
files directly, as described in
[the evaluation guide](evaluation-harness.md#environment). Shell-exported values
take precedence, so you can point one run at a different control plane or auth
context.

Live scenarios need:

1. a reachable 402flow control plane; the default is hosted staging at `https://api-staging.402flow.ai`
2. a reachable demo merchant (see [First-Party Merchant URL](#first-party-merchant-url))
3. an organization and agent that the SDK can authenticate as, with either `X402FLOW_BOOTSTRAP_KEY` or `X402FLOW_RUNTIME_TOKEN` set
4. a funded, enabled execution rail for each network the run pays on

Full `scenario:core` and `scenario:all` runs pay on Base Sepolia, Base mainnet,
Solana devnet, and Solana mainnet. A single scenario needs only its own rail.

## Run Plans

| Command | Scenarios |
| --- | --- |
| `npm run scenario:core` | First-party and mock; the release campaign |
| `npm run scenario:all` | First-party, third-party, and mock |
| `npm run scenario:first-party` | First-party demo-merchant scenarios only |
| `npm run scenario:third-party` | Third-party merchant compatibility scenarios only |
| `npm run scenario:mock` | Mocked governance outcomes only |

Each command rebuilds the SDK, clears `tmp/`, and writes new logs, transcripts,
and `tmp/scenario-summary.txt`. Preserve any artifacts you need first. The runner
stops at the first process, transcript, or outcome-validation failure.

## Release Campaign

`npm run scenario:core` is the default release integration campaign. It is not
an offline test. It runs 12 first-party scenarios and six mocks. Each
first-party scenario pays once: six on testnets, three on Base mainnet, and three
on Solana mainnet. At the current merchant price, mainnet merchant spend is
0.006 USDC, plus network fees. Both mainnet rails must be funded and enabled.

For this plan only, the caller limits each live scenario to one execution
attempt, on its configured merchant route and network, for at most 1000 minor
units of USDC (0.001 USDC). The six mainnet scenarios therefore cannot submit
more than 0.006 USDC in merchant payments per run. These limits do not replace
control-plane policy, and they exclude network fees and model charges.

Before execution, the runner assigns each scenario a business idempotency key
and saves an `.attempt.json` record. It saves partial tool transcripts as calls
complete. Do not rerun a failed campaign until uncertain outcomes are
reconciled: a new campaign uses new keys and clears the previous evidence in
`tmp/`.

The mainnet portion passes only when every Base and Solana mainnet scenario
records:

1. `PASS` in `tmp/scenario-summary.txt`
2. `sdkOutcomeKind=success`
3. merchant HTTP status 200
4. a `receiptId` and `paidRequestId`
5. matching successful `execute_prepared_request` and stored
   `get_execution_result` evidence in the transcript

If either mainnet rail cannot run, the campaign is incomplete.

## Scenarios

### First-party

First-party scenarios target the hosted demo merchant's research-brief routes.
Their names follow the pattern `<network>-research-brief-<variant>`, where
`<network>` is `base-sepolia`, `base-mainnet`, `solana-devnet`, or
`solana-mainnet`. Mainnet variants pay real USDC.

| Variant | Preset | Starting request |
| --- | --- | --- |
| `bazaar-revise` | `revise-json-post` | Incomplete body with no external metadata; the agent revises it from merchant-published Bazaar metadata |
| `ready` | `ready-json-post` | Complete body plus advisory external metadata, ready to execute |
| `revise` | `revise-json-post` | Incomplete body plus advisory external metadata |

The Solana devnet route is the default first-party path and the best choice when
request shaping should matter in a real agent loop. The root
[README](../README.md#hosted-integration-targets) lists all four route URLs.

For the revise variants, expect:

1. `prepare_paid_request` returns `nextAction: revise_request` when merchant-published Bazaar metadata shows that required body fields are missing
2. after one revision, preparation returns `execute`
3. paid execution returns a deterministic JSON body that echoes the accepted brief input and output sections
4. `get_execution_result` returns the same stored result

Example revise run:

```bash
npm run example:openai-harness -- \
  --preset revise-json-post \
  --scenario solana-devnet-research-brief-revise \
  --transcript-file ./tmp/scenario-runs/solana-devnet-research-brief-revise-run.json
```

### Third-party

| Scenario | Preset | Target |
| --- | --- | --- |
| `nickeljoke-compat` | `ready-json-post` | Public compatibility merchant at `https://nickeljoke.vercel.app/api/joke`, called with `POST` |
| `auor-public-holidays-reasoning-revise` | `revise-get-query` | GET request whose required query parameters come from merchant hints |
| `x402-org-protected-ready` | `ready-json-post` | External x402 endpoint `https://x402.org/protected`, ready without revision |

See [Public Compatibility Targets](#public-compatibility-targets) for their
prerequisites.

### Mock

| Scenario | Mocked outcome |
| --- | --- |
| `policy-denied-budget-exceeded` | Budget-cap denial; the final answer must explain the policy block |
| `policy-denied-merchant-not-allowed` | Deny-by-default merchant rejection |
| `policy-blocked-review-event` | Denial with `policyReviewEventId`; the final answer must explain the block and surface the review event |
| `execution-failed-merchant-rejected` | Merchant rejection after payment |
| `execution-inconclusive` | Inconclusive execution outcome |
| `preflight-failed-no-rail` | Missing payment rail before execution |

All six use the `mock-governance` preset and a mock client inside the harness
example. They run the normal `prepare_paid_request`, `execute_prepared_request`,
and `get_execution_result` loop, with the same `AgentHarness` summarization as
live runs, but need no live 402flow API. They check that the model reports
non-success outcomes honestly.

## First-Party Merchant URL

First-party fixtures store only the route path, such as
`/demo-merchant/research-brief/solana-devnet`. The loader resolves that path
against `X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL`, which defaults to
`https://demo-merchant-staging.402flow.ai`. Third-party fixtures use absolute
URLs as written.

To run first-party scenarios against a self-hosted demo merchant, such as one
started with `pnpm dev:demo-merchant` in the 402flow control-plane repository,
set:

```bash
export X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL="http://127.0.0.1:4123"
```

## Public Compatibility Targets

These third-party targets check compatibility with external merchants. They are
not the product-representative path.

### Nickeljoke

`nickeljoke-compat` pays `https://nickeljoke.vercel.app/api/joke`. Use `POST`:
with `GET`, the paid retry can return `405 Method Not Allowed` even after the
merchant accepts the payment proof.

In addition to the [setup](#setup) requirements, the organization needs a
merchant record for `https://nickeljoke.vercel.app` and a funded, enabled Base
Sepolia execution rail.

```bash
npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario nickeljoke-compat \
  --transcript-file ./tmp/nickeljoke-live-run.json
```

### x402.org

`x402-org-protected-ready` pays `https://x402.org/protected`:

```bash
npm run example:openai-harness -- \
  --preset ready-json-post \
  --scenario x402-org-protected-ready \
  --transcript-file ./tmp/x402-org-protected-ready-run.json
```
