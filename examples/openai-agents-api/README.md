# OpenAI Agents API reference integration

Stage 1 checks hosted execution using an **inert, random canary** and makes no
402flow payment. The paid-request example adds a single-agent testnet flow with durable recovery
checkpoints; its live validation is still pending.
The launcher, hosted probe, and caller recovery belong here. Authorization,
policy, payment execution, receipts, spend controls, and audit remain in the
402flow control plane. The design and roadmap remain in that repository:
[design](https://github.com/sellis/agent-pay/blob/main/docs/openai-agents-api-integration-design.md).

This uses the hosted **Agents API**, not the Agents SDK or this repository's
[Responses API harness](../../docs/evaluation-harness.md). No new SDK exports or
runtime dependencies are introduced.

## Current validation

On 2026-09-22, live read-only access passed for `GET /v1/agents?limit=1`,
`GET /v1/vaults?limit=1`, and `GET /v1/models/gpt-6-luna`, using the SDK-local key.
Model retrieval confirms account access; it does not prove hosted compatibility.
Local checks passed: 177 core tests, 17
adapter tests, and lint/type checks for both packages. Tests use simulated
provider records and the actual local 402flow SDK.
The public canary receiver was deployed and verified on 2026-09-23 UTC. Its
empty/supplied-header hashes, no-echo/no-store behavior, and rejected requests
passed live HTTPS checks. The SDK-local configuration now contains its URL.
**Live hosted Stage 1 passed on 2026-09-23 UTC** with `gpt-6-luna`, hosted Node
22.23.2, the supplied SDK 0.1.3 tarball, and Undici 6.28.1. The root and two distinct direct subagents
passed all seven checks each. The report is
`tmp/openai-agents-api/hosted-sdk013-20260923.json`; all three disposable provider
resources were deleted and no creation is unresolved. Staging was awakened
through its existing controller with explicit operator authorization.
The earlier passing SDK 0.1.2 report remains at
`tmp/openai-agents-api/hosted-20260923-proxy.json`.

Two earlier attempts failed command validation. Diagnostic evidence exposed the
executor's shell wrapper and failed direct Node networking; the exact wrapper
and proxy transport fixes are covered by regression tests. All resources from
those attempts were also deleted. No real 402flow credential or payment was used.
Both package dry-run checks passed; no package was published.

## Commands and configuration

Run from the SDK root with its Linux Node/npm toolchain (Node 20+). Install the
repository's existing dependencies. The commands build and pack the local SDK
and compile the example. Generated files stay in ignored `dist/`.

The launcher uses `examples/load-env.mjs`: shell variables take precedence,
then SDK-root `.env.local`, then `.env`. It never reads another repository's env.
Keep `OPENAI_API_KEY` in that SDK-local configuration; never put it on the command
line. Stage 1 ignores all `X402FLOW_*` credential variables.

```bash
# No network calls, even with an API key configured.
npm run example:openai-agents-api -- plan

# Read-only access check: creates no vault, credential, or hosted session.
npm run example:openai-agents-api -- preflight --model gpt-6-luna

# Local simulated-provider and loopback TLS tests; no AWS or API key needed.
npm test -- test/openai-agents-api.test.ts test/openai-agents-proxy.test.ts

# Required core and adapter checks.
npm run check:all
```

The loopback TLS test uses local `openssl` to generate an ephemeral test certificate.

The selected low-cost model is `gpt-6-luna`; there is no automatic model fallback.
See [model pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).
A hosted run incurs OpenAI model and container charges, recorded separately from
402flow spend. The five-minute run timeout is **not a dollar spending cap**.
The example does not calculate provider cost; reconcile it in provider billing.

The receiver and its AWS configuration live in
[`agent-pay/apps/canary-receiver`](https://github.com/sellis/agent-pay/tree/main/apps/canary-receiver).
That app has a local HTTP server and a Lambda Function URL using the same hash
handler. For local receiver development, run `pnpm dev:canary-receiver` from the
`agent-pay` root. SDK unit tests and `plan` require neither that server nor AWS.

For hosted validation, follow the receiver's deployment runbook and configure
the approved public HTTPS URL in SDK-local `.env`:

```ini
OPENAI_AGENTS_MODEL=gpt-6-luna
OPENAI_AGENTS_CANARY_URL=https://<receiver-host>/probe
```

With a deployed endpoint, run only the SDK command locally; no local receiver or
tunnel is needed. Hosted agents cannot reach your localhost. Another approved
public HTTPS deployment of the same receiver also works; Lambda is optional.
The endpoint must forward `Authorization` unchanged and return only
`{"authorizationSha256":"<SHA256 of the exact Authorization header>"}`.
An unauthenticated GET must hash the empty string, not `Bearer `.
Never send a real credential to this receiver.

Once the receiver is ready and access preflight succeeds:

```bash
npm run example:openai-agents-api -- run \
  --model gpt-6-luna \
  --canary-url https://YOUR-APPROVED-HOST/probe
```

Alternatively set `OPENAI_AGENTS_MODEL` and `OPENAI_AGENTS_CANARY_URL` in SDK-local
configuration. Both settings are required for `run`. Only public HTTPS URLs on
port 443 or 8443, without credentials, query parameters, or fragments, are
accepted. The operator must verify that the hostname resolves to a public
receiver; lexical URL validation is not DNS attestation.

## What a hosted pass means

The launcher creates one disposable vault and an `environment_variable`
credential scoped to the canary hostname. It attaches the vault to one hosted
session and supplies no plaintext secret through `environment.env`, files,
prompts, or command arguments. See [OpenAI vault delivery](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults).

The root and exactly two distinct child agents each run the supplied command
once. Every command checks:

- Node supports the SDK, and the supplied local `@402flow/sdk@0.1.3` tarball loads.
- The real SDK's `lookupReceipt` forwards the placeholder and SDK version header
  to a **local intercepted transport**; it makes no authenticated 402flow request.
- The sandbox value differs from the real canary, while the receiver observes
  the real canary's hash after vault substitution.
- An unauthenticated GET reaches `https://api-staging.402flow.ai/api/health`.
- An unauthenticated POST to the owned Base Sepolia research-brief route returns
  HTTP 402 and the expected challenge resource/network. No payment follows.
- A request to `https://example.com/` fails under the restricted network policy.
  An external baseline first establishes that this destination is reachable.
  HTTP error responses and timeouts do not count as a passing rejection.

The hosted environment pins `undici@6.28.1` alongside the SDK. The example uses
its proxy transport because Node's default `fetch` did not reach the allowed
hosts in the initial live attempt. It honors the sandbox's HTTPS/HTTP proxy and
reads `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, or the Linux system CA bundle, retaining
certificate and hostname verification. All public probe destinations use that
proxy, including the negative control. This dependency is development-only in
the SDK repository and is not added to the published SDK's runtime dependencies.

The sandbox allowlist contains only the receiver, API, and owned merchant hosts;
the credential allowlist contains only the receiver. The SDK is supplied as a
local tarball; dependencies use the provider's pinned npm setup. Installation failure is a failed gate; never
broaden egress to make it pass.

The launcher reads all pages of root and child item histories, joins command IDs
to the corresponding completed turns, and checks session and subagent IDs.
Children must name the root command's provider-recorded agent as their parent.
The exact `/bin/bash -lc 'node /workspace/probe.mjs ACTOR'` executor wrapper is
accepted alongside the bare command; appended shell operations are rejected.
Wrong labels, nested or duplicate children, extra or failed commands, missing
results, and duplicate evidence fail validation. A root completed turn is
required; an idle session or model success message is insufficient.

Provider records establish who ran the observed commands. They do not provide
cryptographic attribution for every HTTP request made in a shared sandbox.
A transport rejection does not prove whether the cause was proxy policy, DNS,
or TLS. Arbitrary/encoded exfiltration, wrong-host/redirect substitution,
unfetched provider surfaces, and provider storage/retention remain unverified.
No claim about paid execution or real runtime-token acceptance follows from
passing this inert probe.

## Reports, interruption, and cleanup

Reports default to `tmp/openai-agents-api/<run-id>.json`; use `--report PATH` to
choose a new file. `run` refuses an existing report. Reports are private files
written by atomic rename, with file and directory sync. They retain validated
boolean results and resource/command/turn IDs, not raw transcripts or secrets.
Fetched provider bodies are size-limited and checked for reflected plaintext
secrets before parsing. Errors are fixed codes, without raw provider messages.

Creation intent is saved **before** each POST, then its returned resource ID is
saved before the next step. Creation requests are never retried automatically.
A lost response leaves `resources.pendingCreation` in the report: use the run ID
and saved IDs to inspect provider resources manually. Never clear it or create a
replacement session merely because the first response was lost. Deleting a vault
does not stop a session or prove that an unknown session never existed.

On success, failure, deadline, or Ctrl-C, cleanup sends cancellation and attempts
credential/session/vault deletion. It retries only 409 conflicts, at most three
times per resource. Cleanup uses independent request deadlines so interruption
cannot disable it. Failed or unknown cleanup makes the run fail and retains IDs.

To retry cleanup after reviewing the saved report:

```bash
npm run example:openai-agents-api -- cleanup --report tmp/openai-agents-api/RUN-ID.json
```

Cleanup never resumes execution or creates resources. Only use reports produced
by your own launcher. A `.lock` prevents simultaneous local run/cleanup; after a
hard crash, confirm the original process has stopped before removing that lock.
Keep recovery reports until resources are accounted for. `scenario:core` clears
`tmp/` and includes paid requests; do not run it for this stage.

The unpaid release smoke passed all four expected HTTP 402 challenges at
September 24, 00:19 UTC, and again before the campaign at 00:45 UTC. After AWS access was renewed, inspection confirmed the
earlier HTTP 503 responses coincided with all five staging services and both
databases being parked. The existing runtime controller woke the merchant under
the operator's wake/probe authorization. These smoke checks submitted no payment.
The latest smoke log is `/tmp/402flow-sdk-replacement-smoke.log`.

The operator subsequently authorized one bounded `scenario:core` campaign. At
September 24, 00:42 UTC, it stopped in its first Base Sepolia scenario before SDK
execution: the new caller guard incorrectly required optional challenge
precision. That guard is now corrected and covered by regression tests using
USDC challenges without precision metadata. Read-only control-plane inspection
found no campaign paid requests and no agent paid requests since the run began.
No mainnet or testnet payment occurred; OpenAI usage did occur. The stopped run
was not retried. Evidence: `tmp/scenario-summary.first-stop.txt` and
`tmp/core-campaign-first-stop-reconciliation.json`. Earlier hosted reports were backed up
to `/tmp/402flow-sdk-before-core.uKhmJP` and restored to their original paths.

The separately authorized replacement campaign ran from 00:45 to 00:52 UTC.
All 18 scenarios passed: 12 paid scenarios and six mocks. Three Base mainnet
and three Solana mainnet payments totaled **0.006000 USDC** in merchant spend;
the six testnet payments totaled 0.006000 test USDC. Gas and model usage are
separate. Read-only control-plane verification found exactly 12 paid requests,
12 confirmed receipts, and one matching debit each, with the same receipt and
paid-request IDs recorded by execute and stored-result lookup.

The original command exited at a mock wording comparison: the expected budget
denial said “would exceed” instead of “exceeded.” After correcting that fixture
and adding regression coverage, the saved transcript passed offline evaluation.
Only the five remaining mocks continued, with payment credentials removed from
their environment. No paid scenario was rerun. The initial command result is
retained in `tmp/scenario-summary.initial.txt`; the complete evaluated campaign
and receipt evidence are `tmp/scenario-summary.txt` and
`tmp/core-campaign-reconciliation.json`.

This campaign used `gpt-6-luna`, the SDK's local Responses harness, SDK-local
credentials, and the local 0.1.3 control plane at `http://127.0.0.1:3001`, against
the hosted staging merchant. It establishes SDK paid-flow compatibility; the
hosted Agents API paid-request proof still requires the control-plane rollout.
Nothing was published or deployed, and changes remain uncommitted.

## Paid request example

The paid-request example is implemented and tested locally with SDK 0.1.3. **Hosted paid execution is
pending.** Stage 1 passed again with the local 0.1.3 artifact; this does not prove
real hosted runtime-token acceptance or payment. Current local checks passed 198 core tests and 17 adapter tests, lint,
type checks, and both package dry runs. Both hosted stages now receive
`dist/402flow-sdk-0.1.3.tgz`, packed
from this checkout, plus pinned `zod@3.25.76` and `undici@6.28.1`. No registry
SDK fallback or publication occurs. Session metadata records the artifact's
SHA-256; the paid-request launcher also saves it in the report. Local tests extract the supplied
tarball and execute the rewritten hosted modules against a fake control plane.
The payload uses the documented [hosted files and setup commands](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted).

The target API must accept **0.1.3**. Current `agent-pay` source consumes the local
0.1.3 tarball, but the deployed staging API (task revision 49) still accepts only
0.1.2; its unchanged image was verified again on September 24. The operator
selected normal npm publication and a control-plane dependency update for the
rollout; the earlier local image candidate is superseded and has not been pushed
or deployed. The API version gate accepts only its installed SDK version, so an
API rollout using 0.1.3 also stops accepting 0.1.2.
A failed runtime-token exchange never launches an authenticated agent or proceeds
to payment.

The trusted launcher uses `preparePaidRequest` for an unpaid merchant probe,
validates the fixed Base Sepolia USDC challenge, then atomically saves the exact
prepared request, challenge, identity, context, stable business key, and input
fingerprint. Both the file and containing directory are synced. Only then does
it exchange the bootstrap key, deliver the runtime token through a host-scoped
vault, and create the hosted session. Session creation acknowledges the durable
checkpoint: no callback server, tunnel, receiver, or new API is needed.

The root agent executes the saved snapshot once with `executePreparedRequest`,
then looks up its receipt. The hosted transport permits only decision and
receipt requests to the staging API. It cannot re-probe through that transport.
Extra commands or subagents fail attribution checks. Policy, approval, payment,
receipts, and audit remain in the control plane. `AgentHarness` memory and
sandbox files are not durable stores.

### Setup and read-only preflight

Use a dedicated staging agent (`openai-agents-test`) and its bootstrap credential, with no concurrent
exchanges for that agent during a run. The launcher correlates the runtime session
using before/after session lists; it never decodes the opaque token.
Ambiguous correlation fails closed and requires operator inspection.

Set these in SDK-local `.env` or `.env.local`, alongside the existing OpenAI key:

```ini
X402FLOW_CONTROL_PLANE_BASE_URL="https://api-staging.402flow.ai"
X402FLOW_ORGANIZATION="acme-labs"
OPENAI_AGENTS_AGENT="openai-agents-test"
OPENAI_AGENTS_BOOTSTRAP_KEY="..."
OPENAI_AGENTS_OPERATOR_TOKEN="..."
```

`OPENAI_AGENTS_AGENT` is the dedicated **402flow external ID**, not the agent UUID
or an OpenAI agent ID. It overrides `X402FLOW_AGENT` for this example, so browser
tests can retain `X402FLOW_AGENT="test-agent"`. The organization remains
`X402FLOW_ORGANIZATION`. Preflight and execution require the configured identity
to match the control-plane records selected by the JSON config's UUIDs. Setting
this variable does not create the agent or change which agent owns a key; use
the dedicated agent's bootstrap credential.

The operator token needs access to setup/lifecycle records and permission to
revoke the selected agent's runtime sessions. Operator and bootstrap credentials
stay local; only the runtime token goes to the vault. Standard `X402FLOW_*` values
are accepted only with the explicit staging URL and identity matching the
control-plane records. A localhost URL fails before any network call. Commented
env entries are inactive. To retain active localhost defaults, supply a staging
`OPENAI_AGENTS_BOOTSTRAP_KEY` override and, optionally,
`OPENAI_AGENTS_OPERATOR_TOKEN`; these take precedence over the standard
key/token variables. Never put secrets in command arguments or JSON configuration.

Copy [paid-request.config.example.json](paid-request.config.example.json) to ignored `tmp/`.
Replace its placeholder organization, agent, per-request policy (`requestPolicyId`),
and daily budget policy (`budgetPolicyId`) UUIDs. If you have
the bootstrap credential UUID, optionally add `credentialId` to pin it. Otherwise,
the control plane authenticates the existing key and the launcher validates and
records the issued session's credential UUID before vault delivery; no replacement
key is needed. Generate a new operation UUID with
`node -e "console.log(require('node:crypto').randomUUID())"`.
The fixed route/body cannot select mainnet or another merchant. The maximum is
**1000 minor units (0.001 test USDC)** for an operation. Testnet gas and OpenAI
model/container charges are separate.

Preflight requires an active organization, enabled agent, an active bootstrap
credential when its UUID is supplied, enabled Base Sepolia payment connection, and exactly one eligible
wallet. Both selected policies must be active, enabled, and scoped only to the
selected agent with per-member application. The per-request USDC policy must
have `basis: per_request`, `window: none`, and a cap no greater than
`maxAmountMinor` (at most 1000). The separate aggregate USDC policy must have
`basis: aggregate_over_time`, `window: day`, and a cap no greater than
`maxBudgetAmountMinor` (the example uses 100000, or 0.1 USDC). Raising the daily
budget does not raise the per-request ceiling. The report records both policy
revision IDs. A lower per-request cap, such as the denial fixture's 999, is
accepted without repair; the control plane determines the actual outcome.
Preflight reads existing setup and reports the posture; it never repairs setup
or duplicates policy evaluation. Funding and final authorization remain
control-plane execution checks.

```bash
npm run example:openai-agents-api -- paid-plan
npm run example:openai-agents-api -- paid-preflight --config tmp/paid-request-success.json
```

`paid-plan` is network-free. `paid-preflight` uses only operator GET requests;
it creates no token, hosted resource, or payment. `paid-run` repeats those
checks plus read-only OpenAI model/Agents/vault access checks. Setup preflight
alone does not prove SDK version acceptance, runtime-token acceptance, or funding.

### Explicit execution and evidence

After setup, API compatibility, and a bounded testnet payment are approved:

```bash
npm run example:openai-agents-api -- paid-run \
  --config tmp/paid-request-success.json --allow-testnet-payment
```

Even deny/review cases require the flag because current control-plane policy
determines the outcome. Set `expectedOutcome` to `success`, `denied`, or `review`
for separate cases and configure that state through the control plane first.
Use a new operation only for a distinct business case after resolving earlier
ambiguous operations. The launcher never changes policy or approves a review.
Live paid-request acceptance requires a successful fulfillment and a denial (including
`policy_review_required`) with saved provider and control-plane evidence. Use
`openai-agents-test` for success: its seeded per-request cap is 1000 and its daily
budget is 100000. For repeatable rejection, use `openai-agents-denied-test`, its
own bootstrap key and policy UUIDs, and `expectedOutcome: review`: its per-request
cap is 999 while the daily budget remains 100000. Leave the resulting review
unapproved. There is no need to exhaust or reset the success agent's budget.
Avoid concurrent credential exchanges for each agent; stop and reconcile any
unexpected outcome before continuing.

Reports are reserved at `tmp/openai-agents-api/paid-requests/<operationId>.json` before
work starts. An existing report prevents another run. Success requires HTTP
200, SDK receipt lookup, matching identities and request/attempt/receipt IDs,
amount/network, confirmed settlement, and runtime-session/credential audit
lineage. Denied/review cases require the corresponding audit/review records and
no payment attempt or receipt. Reports save IDs and a merchant-body hash, without
raw merchant content or provider transcripts.

### Recovery

The launcher preserves SDK outcome kinds and known payment IDs even if receipt
lookup fails after execution. It never retries payment. Cleanup revokes the
runtime session first, then cancels/deletes the OpenAI session, credential, and
vault. Failed or unknown cleanup makes the report fail. The five-minute deadline
and resource deletion do not prove that payment did not occur.

```bash
# Read existing records for the original operation; never execute or re-probe.
npm run example:openai-agents-api -- paid-reconcile --report tmp/openai-agents-api/paid-requests/OPERATION-ID.json

# Retry revocation/provider deletion only.
npm run example:openai-agents-api -- paid-cleanup --report tmp/openai-agents-api/paid-requests/OPERATION-ID.json
```

An empty reconciliation result is not proof of no payment. Preserve the
checkpoint and apply the [SDK retry rules](../../docs/compatibility.md#safe-retries):
denials need policy/approval changes, preflight failures need a fix, pending/lost
responses retain the key, inconclusive outcomes need reconciliation, hard
failures need inspection, and paid fulfillment failures need an explicit
merchant recovery plan. Automatic replay and renewal are deferred to Stage 3.
Never switch to a fresh operation UUID to bypass an unresolved result.

Lost exchange/creation responses retain pending intent and before-session IDs
for manual inspection. Do not revoke unrelated sessions. Cleanup accepts only
trusted launcher reports. After a hard crash, confirm the original process
stopped before removing its `.lock`. Preserve reports before any cleanup of
`tmp/`; `scenario:core` deletes that directory and pays mainnet.

## Local checks

```bash
npm test -- test/openai-agents-api.test.ts test/openai-agents-paid-request.test.ts test/openai-agents-proxy.test.ts
npm run check:all
npm run example:openai-agents-api -- plan
```

`check:all` runs lint, type checks, and tests for both the core and adapter. The
focused tests require a compiler subprocess, but no external
network, OpenAI key, hosted session, or paid request. They are local evidence,
not a replacement for hosted acceptance.
