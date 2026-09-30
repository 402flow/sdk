# OpenAI Agents API Reference Integration

This example runs the 402flow SDK in OpenAI's hosted Agents API. It does not use
the Agents SDK or this repository's
[Responses API harness](../../docs/evaluation-harness.md), and it adds no SDK
exports or runtime dependencies. The launcher, hosted probe, and caller recovery
live here. Authorization, policy, payment execution, receipts, spend controls,
and audit stay in the 402flow control plane.

The example has two parts:

1. A capability probe (Stage 1) that checks hosted execution with an inert,
   random canary. It makes no 402flow payment.
2. A paid-request example that makes one Base Sepolia testnet purchase from a
   hosted agent, with durable recovery checkpoints.

The design document and roadmap are in the 402flow control-plane repository
(`docs/openai-agents-api-integration-design.md`).

## Status

As of 2026-09-24:

- The hosted capability probe passed with SDK 0.1.3.
- One hosted Base Sepolia purchase with SDK 0.1.3 succeeded, with matching
  receipt, audit, and ledger evidence.
- A separate hosted policy-review rejection passed with no payment.
- Replay, concurrency, subagent payment, and broader recovery checks are
  deferred. No hosted run has used a later SDK version.

See the [validation record](#validation-record) for details and evidence.

## Requirements

Run commands from the SDK root with its Linux Node/npm toolchain (Node 20+) and
the repository's installed dependencies. The commands build and pack the local
SDK and compile the example into ignored `dist/`.

The launcher reads configuration through `examples/load-env.mjs`: shell
variables first, then SDK-root `.env.local`, then `.env`. It never reads another
repository's env. Keep `OPENAI_API_KEY` in that SDK-local configuration, never
on the command line.

The selected model is `gpt-6-luna`
([pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)). There is
no automatic model fallback. Hosted runs incur OpenAI model and container
charges, separate from 402flow spend. The five-minute run timeout is not a
spending cap, and the example does not calculate provider cost; reconcile it in
provider billing.

## Capability Probe

The probe ignores all `X402FLOW_*` credential variables.

```bash
# No network calls, even with an API key configured.
npm run example:openai-agents-api -- plan

# Read-only access check. Creates no vault, credential, or hosted session.
npm run example:openai-agents-api -- preflight --model gpt-6-luna

# Hosted run, once the canary receiver is configured and preflight passes.
npm run example:openai-agents-api -- run \
  --model gpt-6-luna \
  --canary-url https://YOUR-APPROVED-HOST/probe
```

### Canary receiver

A hosted run needs a public HTTPS canary receiver. Hosted agents cannot reach
your localhost. The receiver's source and deployment runbook are in the 402flow
control-plane repository (`apps/canary-receiver`). It provides a local HTTP
server, started with `pnpm dev:canary-receiver`, and a Lambda Function URL that
share one hash handler. The local server is for receiver development only; SDK
tests and `plan` need neither the server nor AWS. `.env.example` includes the
URL of the deployed staging receiver. Any other approved public HTTPS deployment
of the same receiver also works; Lambda is optional.

The receiver must forward `Authorization` unchanged and return only
`{"authorizationSha256":"<SHA256 of the exact Authorization header>"}`. An
unauthenticated GET must hash the empty string, not `Bearer `. Never send a real
credential to this receiver.

`run` requires a model and a canary URL, from flags or from SDK-local `.env`:

```ini
OPENAI_AGENTS_MODEL=gpt-6-luna
OPENAI_AGENTS_CANARY_URL=https://<receiver-host>/probe
```

The canary URL must be public HTTPS on port 443 or 8443, with no credentials,
query parameters, or fragment. This validation is lexical only: the operator
must confirm that the hostname resolves to a public receiver.

### What a pass means

The launcher creates one disposable vault and an `environment_variable`
credential scoped to the canary hostname, and attaches the vault to one hosted
session. No plaintext secret passes through `environment.env`, files, prompts,
or command arguments. See
[OpenAI vault delivery](https://developers.openai.com/api/docs/guides/agents-api/tools/vaults).

The root agent and exactly two distinct child agents each run the probe command
once. Each run checks that:

- Node supports the SDK, and the supplied local `@402flow/sdk` tarball loads
  with the exact version that the launcher recorded.
- The real SDK's `lookupReceipt` forwards the placeholder and SDK version header
  to a local intercepted transport. It makes no authenticated 402flow request.
- The sandbox value differs from the real canary, while the receiver observes
  the real canary's hash after vault substitution.
- An unauthenticated GET reaches `https://api-staging.402flow.ai/api/health`.
- An unauthenticated POST to the owned Base Sepolia research-brief route returns
  HTTP 402 with the expected challenge resource and network. No payment follows.
- A request to `https://example.com/` fails under the restricted network policy.
  An external baseline first confirms that this destination is reachable. HTTP
  error responses and timeouts do not count as a passing rejection.

The sandbox network allowlist contains only the receiver, API, and owned
merchant hosts. The credential allowlist contains only the receiver. The SDK
arrives as a local tarball, and other dependencies use the provider's pinned npm
setup. An installation failure fails the gate; never broaden egress to make it
pass.

The hosted environment pins `undici@6.28.1` alongside the SDK. The example uses
Undici's proxy transport because Node's default `fetch` did not reach the
allowed hosts in the first live attempt. The transport honors the sandbox's
HTTPS/HTTP proxy and reads `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, or the Linux system
CA bundle, keeping certificate and hostname verification. All public probe
destinations use that proxy, including the negative control. Undici is a
development dependency of this repository only; the published SDK does not
depend on it.

The launcher reads every page of the root and child item histories, joins
command IDs to their completed turns, and checks session and subagent IDs. Each
child must name the root command's provider-recorded agent as its parent. The
executor's exact `/bin/bash -lc 'node /workspace/probe.mjs ACTOR'` wrapper is
accepted alongside the bare command; appended shell operations are rejected.
Wrong labels, nested or duplicate children, extra or failed commands, missing
results, and duplicate evidence fail validation. A completed root turn is
required; an idle session or a model's success message is not enough.

A pass has limits. Provider records show who ran the observed commands, but they
do not cryptographically attribute every HTTP request made in a shared sandbox.
A transport rejection does not show whether proxy policy, DNS, or TLS caused
it. Arbitrary or encoded exfiltration, wrong-host or redirect substitution,
unfetched provider surfaces, and provider storage and retention remain
unverified. Passing this inert probe says nothing about paid execution or real
runtime-token acceptance.

### Reports, interruption, and cleanup

Reports default to `tmp/openai-agents-api/<run-id>.json`; use `--report PATH` to
choose a new file. `run` refuses to reuse an existing report. Reports are
private files written by atomic rename, with file and directory sync. They keep
validated boolean results and resource, command, and turn IDs, but no raw
transcripts or secrets. Fetched provider bodies are size-limited and checked for
reflected plaintext secrets before parsing. Errors use fixed codes, without raw
provider messages.

The launcher saves creation intent before each POST, then saves the returned
resource ID before the next step. It never retries a creation request
automatically. A lost response leaves `resources.pendingCreation` in the report:
use the run ID and saved IDs to inspect provider resources manually. Do not
clear it, and do not create a replacement session only because the first
response was lost. Deleting a vault neither stops a session nor proves that an
unknown session never existed.

On success, failure, deadline, or Ctrl-C, cleanup sends cancellation and tries
to delete the credential, session, and vault. It retries only 409 conflicts, at
most three times per resource. Cleanup uses its own request deadlines, so an
interruption cannot disable it. Failed or unknown cleanup fails the run and
keeps the IDs.

To retry cleanup after reviewing the saved report:

```bash
npm run example:openai-agents-api -- cleanup --report tmp/openai-agents-api/RUN-ID.json
```

Cleanup never resumes execution or creates resources. Use only reports that
your own launcher produced. A `.lock` file prevents a simultaneous local run and
cleanup; after a hard crash, confirm that the original process has stopped
before you remove the lock. Keep recovery reports until all resources are
accounted for. Do not run `scenario:core` for this probe: it clears `tmp/` and
makes paid requests.

## Paid-Request Example

### How it works

The trusted launcher calls `preparePaidRequest` for an unpaid merchant probe and
validates the fixed Base Sepolia USDC challenge. It then atomically saves the
exact prepared request, challenge, identity, context, stable business key, and
input fingerprint, and syncs both the file and its directory. Only after that
does it exchange the bootstrap key for a runtime token, deliver the token
through a host-scoped vault, and create the hosted session. Because session
creation happens after the durable checkpoint, no callback server, tunnel,
receiver, or new API is needed.

The root agent executes the saved snapshot once with `executePreparedRequest`,
then looks up its receipt. The hosted transport allows only decision and receipt
requests to the staging API, so the agent cannot re-probe through it. Extra
commands or subagents fail attribution checks. `AgentHarness` memory and sandbox
files are not durable stores.

The fixed route and body cannot select mainnet or another merchant. The maximum
is 1000 minor units (0.001 test USDC) per operation. Testnet gas and OpenAI model
and container charges are separate.

The capability probe and the paid request both receive
`dist/402flow-sdk-<version>.tgz`, packed from this checkout, plus pinned
`zod@3.25.76` and `undici@6.28.1`. There is no registry fallback, and nothing is
published. Session metadata records the artifact's SHA-256, and the paid-request
report saves it too. The payload uses the documented
[hosted files and setup commands](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted).

The artifact name, report metadata, CLI plans, and sandbox version checks all
derive from the SDK's exported version, so a version bump needs no example
edits. Older reports keep their recorded versions and remain valid for cleanup
and reconciliation.

The target API must accept the SDK version being run; its version gate accepts
only its installed SDK version. A failed runtime-token exchange never launches an
authenticated agent or proceeds to payment.

### Configuration

Use a dedicated staging agent, such as `openai-agents-test`, and its bootstrap
credential. Avoid concurrent credential exchanges for that agent during a run:
the launcher identifies the new runtime session by comparing session lists
before and after the exchange, and never decodes the opaque token. Ambiguous
correlation fails closed and needs operator inspection.

The root [`.env.example`](../../.env.example) lists these settings as comments.
Copy them into SDK-local `.env` or `.env.local`, then uncomment and fill them in
next to `OPENAI_API_KEY`:

```ini
X402FLOW_CONTROL_PLANE_BASE_URL="https://api-staging.402flow.ai"
X402FLOW_ORGANIZATION="acme-labs"
OPENAI_AGENTS_AGENT="openai-agents-test"
OPENAI_AGENTS_BOOTSTRAP_KEY="..."
OPENAI_AGENTS_DENIED_AGENT="openai-agents-denied-test"
OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY="..."
OPENAI_AGENTS_OPERATOR_TOKEN="..."
```

`OPENAI_AGENTS_AGENT` is the 402flow agent's external ID, not its UUID or an
OpenAI agent ID. It overrides `X402FLOW_AGENT` for this example, so browser tests
can keep `X402FLOW_AGENT="test-agent"`. The organization comes from
`X402FLOW_ORGANIZATION`. Preflight and execution require this identity to match
the control-plane records selected by the JSON config's UUIDs. The variable
does not create the agent or change which agent owns a key; use that agent's own
bootstrap credential.

The default `success` profile uses `OPENAI_AGENTS_AGENT` and
`OPENAI_AGENTS_BOOTSTRAP_KEY`. `--agent-profile denied` uses
`OPENAI_AGENTS_DENIED_AGENT` and `OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY`, together
with that agent's JSON config. Both pairs can stay configured; omit the denial
pair if you run only the success case. Without `--agent-profile`, commands use
the success profile.

The denial profile never falls back to the success agent or the SDK
credentials. An explicitly empty key fails, and a rejected exchange never
retries another credential. A profile selects credentials only. It does not
change policy or infer the expected outcome, and the JSON config's UUIDs must
still match the selected identity.

The operator token needs access to setup and lifecycle records and permission to
revoke the selected agent's runtime sessions. One token can serve both agents if
it has those permissions. `OPENAI_AGENTS_OPERATOR_TOKEN` overrides
`OPERATOR_BEARER_TOKEN`.

Operator and bootstrap credentials stay local. Only the runtime token, which the
launcher creates, goes to the vault; do not configure a hosted runtime token. If
the success profile falls back to `X402FLOW_BOOTSTRAP_KEY`, the example requires
the explicit staging URL and an identity that matches the control-plane records;
a localhost URL fails before any network call. With a dedicated staging key,
other examples can keep their localhost defaults, because the hosted purchase
always uses the fixed staging API. Commented env entries are inactive. Never put
secrets in command arguments or JSON configuration.

Copy [paid-request.config.example.json](paid-request.config.example.json) to
ignored `tmp/` and set:

- `organizationId` and `agentId` for the selected identity
- `requestPolicyId`, the per-request policy
- `budgetPolicyId`, the daily budget policy
- `operationId`, a new UUID from
  `node -e "console.log(require('node:crypto').randomUUID())"`
- `model`, `expectedOutcome` (`success`, `denied`, or `review`),
  `maxAmountMinor`, and `maxBudgetAmountMinor`
- optionally, `credentialId` to pin the bootstrap credential

These are JSON fields, not environment variables. `OPENAI_AGENTS_MODEL` and
`OPENAI_AGENTS_CANARY_URL` apply only to the capability probe. Without
`credentialId`, the control plane authenticates the existing key, and the
launcher validates and records the issued session's credential UUID before vault
delivery. No replacement key is needed.

### Preflight

Preflight requires:

- an active organization, an enabled agent, and, if `credentialId` is set, an
  active bootstrap credential
- an enabled Base Sepolia payment connection with exactly one eligible wallet
- both selected policies active, enabled, and scoped only to the selected agent
  with per-member application
- a per-request USDC policy with `basis: per_request`, `window: none`, and a cap
  no greater than `maxAmountMinor` (at most 1000)
- a separate aggregate USDC policy with `basis: aggregate_over_time`,
  `window: day`, and a cap no greater than `maxBudgetAmountMinor` (the example
  uses 100000, or 0.1 USDC)

Raising the daily budget does not raise the per-request ceiling. The report
records both policy revision IDs. A lower per-request cap, such as the denial
agent's 999, is accepted as it is, and the control plane decides the actual
outcome. Preflight reads the existing setup and reports the posture. It never
repairs setup or duplicates policy evaluation. Funding and final authorization
remain control-plane checks at execution.

```bash
npm run example:openai-agents-api -- paid-plan
npm run example:openai-agents-api -- paid-preflight --config tmp/paid-request-success.json
npm run example:openai-agents-api -- paid-preflight \
  --agent-profile denied --config tmp/paid-request-denied.json
```

`paid-plan` makes no network calls. `paid-preflight` makes only operator GET
requests and creates no token, hosted resource, or payment. `paid-run` repeats
those checks and adds read-only OpenAI model, Agents, and vault access checks.
Preflight alone does not prove SDK version acceptance, runtime-token acceptance,
or funding.

### Running

Run only after the setup, API compatibility, and a bounded testnet payment are
approved:

```bash
npm run example:openai-agents-api -- paid-run \
  --config tmp/paid-request-success.json --allow-testnet-payment
```

For the denial case, add `--agent-profile denied` and use its config. Every run
needs `--allow-testnet-payment`, including denial and review cases, because the
current control-plane policy decides the outcome. Set `expectedOutcome` for each
case, and configure that state through the control plane first. The launcher
never changes policy or approves a review.

Live acceptance requires one successful fulfillment and one denial (including
`policy_review_required`), each with saved provider and control-plane evidence:

- Success: use `openai-agents-test`. Its seeded per-request cap is 1000 and its
  daily budget is 100000.
- Denial: use `openai-agents-denied-test` with its own bootstrap key and policy
  UUIDs, and `expectedOutcome: review`. Its per-request cap is 999 and its daily
  budget is 100000. Leave the resulting review unapproved.

There is no need to exhaust or reset the success agent's budget. Use a new
operation only for a distinct business case, after resolving earlier ambiguous
operations. Avoid concurrent credential exchanges for each agent, and stop to
reconcile any unexpected outcome before continuing.

### Evidence

The launcher reserves `tmp/openai-agents-api/paid-requests/<operationId>.json`
before work starts; an existing report blocks another run. Success requires HTTP
200, an SDK receipt lookup, matching identities and request, attempt, and receipt
IDs, the expected amount and network, confirmed settlement, and runtime-session
and credential audit lineage. Denied and review cases require the matching audit
and review records, and no payment attempt or receipt. Reports save IDs and a
hash of the merchant body, without raw merchant content or provider transcripts.

A fulfilled provisional receipt can arrive before chain confirmation. For a
provisional receipt awaiting reconciliation, the launcher rechecks the same
operation every five seconds, at most twelve times, within the overall run
deadline. Identity, amount, fulfillment, or audit mismatches still stop the run
immediately. If the confirmation checks run out, the report keeps the paid
outcome and fails for read-only reconciliation. The launcher never repeats a
payment.

### Recovery

The launcher keeps SDK outcome kinds and known payment IDs even if receipt lookup
fails after execution, and it never retries payment. Cleanup revokes the runtime
session first, then cancels and deletes the OpenAI session, credential, and
vault. Failed or unknown cleanup fails the report. Neither the five-minute
deadline nor resource deletion proves that no payment occurred.

```bash
# Read existing records for the original operation. Never executes or re-probes.
npm run example:openai-agents-api -- paid-reconcile --report tmp/openai-agents-api/paid-requests/OPERATION-ID.json

# Retry runtime-session revocation and provider deletion only.
npm run example:openai-agents-api -- paid-cleanup --report tmp/openai-agents-api/paid-requests/OPERATION-ID.json
```

An empty reconciliation result does not prove that no payment occurred. Keep the
checkpoint and follow the
[SDK retry rules](../../docs/compatibility.md#safe-retries): denials need a
policy or approval change, preflight failures need a fix, pending or lost
responses keep the same key, inconclusive outcomes need reconciliation, hard
failures need inspection, and paid fulfillment failures need an explicit
merchant recovery plan. Automatic replay and renewal are deferred to Stage 3.
Never switch to a new operation UUID to get around an unresolved result.

Lost exchange or creation responses keep the pending intent and the
before-exchange session IDs for manual inspection. Do not revoke unrelated
sessions. Cleanup accepts only trusted launcher reports. After a hard crash,
confirm that the original process has stopped before you remove its `.lock`.
Preserve reports before anything clears `tmp/`: `scenario:core` deletes that
directory and pays on mainnet.

## Local Checks

```bash
npm test -- test/openai-agents-api.test.ts test/openai-agents-paid-request.test.ts test/openai-agents-proxy.test.ts
npm run check:all
npm run example:openai-agents-api -- plan
```

The focused tests use simulated provider records and the real local SDK. They
extract the packed SDK tarball and run the rewritten hosted modules against a
fake control plane, and they cover delayed confirmation, bounded polling,
cancellation, and immediate rejection of invalid evidence. They need a compiler
subprocess and local `openssl`, which generates an ephemeral certificate for the
loopback TLS test. They need no external network, AWS, OpenAI key, hosted
session, or paid request. `check:all` runs lint, type checks, and tests for the
core and adapter packages.

Local checks are not a substitute for hosted acceptance.

## Validation Record

Times are UTC. Report paths under `tmp/` and `/tmp/` refer to the operator's
local, ignored files.

### Access and capability probe

On 2026-09-22, read-only access passed for `GET /v1/agents?limit=1`,
`GET /v1/vaults?limit=1`, and `GET /v1/models/gpt-6-luna` with the SDK-local key.
Model retrieval confirms account access, not hosted compatibility. Local checks
passed: 177 core tests, 17 adapter tests, and lint and type checks for both
packages.

On 2026-09-23, the public canary receiver was deployed and verified. Its empty
and supplied-header hashes, no-echo and no-store behavior, and request
rejections passed live HTTPS checks. Its URL was added to the SDK-local
configuration.

Later on 2026-09-23, the hosted capability probe passed with `gpt-6-luna`,
hosted Node 22.23.2, the supplied SDK 0.1.3 tarball, and Undici 6.28.1. The root
agent and two distinct direct subagents each passed all seven checks. All three
disposable provider resources were deleted, and no creation is unresolved.
Staging was woken through its existing controller with explicit operator
authorization. The report is
`tmp/openai-agents-api/hosted-sdk013-20260923.json`. An earlier passing SDK
0.1.2 report is `tmp/openai-agents-api/hosted-20260923-proxy.json`.

Two earlier attempts failed command validation. Their diagnostics exposed the
executor's shell wrapper and failed direct Node networking. Regression tests now
cover the wrapper and proxy transport fixes. Resources from those attempts were
deleted. No real 402flow credential or payment was used, both package dry-run
checks passed, and no package was published.

### SDK 0.1.3 release campaign, 2026-09-24

This campaign validated SDK paid-flow compatibility with the local Responses
harness, not the hosted Agents API. It used `gpt-6-luna`, SDK-local credentials,
and a local 0.1.3 control plane at `http://127.0.0.1:3001`, against the hosted
staging merchant.

The unpaid release smoke passed all four HTTP 402 challenges at 00:19 and again
at 00:45, submitting no payment. Once AWS access was renewed, inspection showed
that earlier HTTP 503 responses coincided with all five staging services and
both databases being parked. The existing runtime controller woke the merchant
under the operator's wake and probe authorization. The latest smoke log is
`/tmp/402flow-sdk-replacement-smoke.log`.

The first authorized `scenario:core` run stopped at 00:42 in its first Base
Sepolia scenario, before SDK execution: the new caller guard wrongly required
optional challenge precision. The guard is fixed and covered by regression tests
that use USDC challenges without precision metadata. Read-only control-plane
inspection found no paid requests from the campaign or the agent since the run
began. No payment occurred, though OpenAI usage did. The stopped run was not
retried. Evidence: `tmp/scenario-summary.first-stop.txt` and
`tmp/core-campaign-first-stop-reconciliation.json`. Earlier hosted reports were
backed up to `/tmp/402flow-sdk-before-core.uKhmJP` and restored to their
original paths.

The separately authorized replacement campaign ran from 00:45 to 00:52. All 18
scenarios passed: 12 paid scenarios and six mocks. Three Base mainnet and three
Solana mainnet payments totaled 0.006000 USDC in merchant spend, and six testnet
payments totaled 0.006000 test USDC. Gas and model usage are separate.
Read-only control-plane verification found exactly 12 paid requests, 12
confirmed receipts, and one matching debit each, with the same receipt and
paid-request IDs recorded by execution and stored-result lookup.

That command first exited on a mock wording comparison: the expected budget
denial said "would exceed" instead of "exceeded." After the fixture was corrected
and covered by a regression test, the saved transcript passed offline
evaluation. Only the five remaining mocks were then run, with payment
credentials removed from their environment. No paid scenario was rerun. The
initial result is in `tmp/scenario-summary.initial.txt`. The complete evaluated
campaign and receipt evidence are in `tmp/scenario-summary.txt` and
`tmp/core-campaign-reconciliation.json`.

The campaign did not publish or deploy anything. The operator then published and
deployed the 0.1.3 control-plane dependency before the hosted purchase.

### Hosted purchase, 2026-09-24

The operator authorized one Base Sepolia purchase against the hosted AWS
environment: at most 0.001 test USDC, plus testnet fees and OpenAI usage.
Staging task revision 50 accepted the example's 0.1.3 credential exchange and
payment. The root agent used `gpt-6-luna`, SDK 0.1.3, and a vault-delivered
runtime credential for `acme-labs` / `openai-agents-test`. It returned SDK
`success`, merchant HTTP 200, and a matching SDK receipt lookup.

- Operation: `5efec117-8b4b-483e-b788-3ddc4bb77d30`
- Paid request: `69ca7791-d255-4903-b46d-43c9748c4dfd`
- Receipt: `1547fd3c-d557-46cd-bf54-fe9f785fe011`
- Merchant amount: 0.001000 Base Sepolia test USDC, with exactly one matching
  ledger debit. Testnet fees and OpenAI charges are separate.

Fulfillment completed at 01:53:09. The command stopped with
`paid_request_receipt_not_confirmed` before the chain observer confirmed the
receipt at 01:53:38. Read-only reconciliation at 01:55 reran the receipt and
audit assertions successfully and verified the matching debit. No payment was
retried. The original failed report is unchanged at
`tmp/openai-agents-api/paid-requests/5efec117-8b4b-483e-b788-3ddc4bb77d30.json`;
the reconciliation uses the same path with `-reconciliation.json`. The runtime
session is revoked, and the OpenAI session, credential, and vault are deleted.
Command and turn attribution and runtime and credential audit lineage match.

The bounded confirmation rechecks described under [Evidence](#evidence) were
added after this run. They are tested locally; the live purchase was not
repeated to test them.

### Hosted policy-review rejection, 2026-09-24

This separately authorized run used `openai-agents-denied-test`, its own
bootstrap credential, and `gpt-6-luna`. Read-only preflight confirmed the
agent's per-request cap of 999 minor units, below the merchant's 1000-unit Base
Sepolia request. Its separate daily budget remained 100000. No policy was
changed.

The hosted command passed at 02:05:55 and returned SDK `denied` with
`policy_review_required`. Provider command and turn attribution and the
control-plane runtime-session and credential audit lineage matched.

- Operation: `7d9577ab-966a-4a76-88d6-be72d313ddb2`
- Paid request: `cddcad5a-b4ca-4e45-9ab2-fbe8ccaac192`, state `denied`
- Policy review: `bac7cf6b-9af3-4a6b-ab83-d14c363778b2`, left open
- No payment attempts, receipts, or ledger entries for this operation, and no
  merchant payment. OpenAI usage is separate.

Runtime session `8b248f7f-4a99-47b2-b344-c7fd922ea392` is revoked. The OpenAI
session, vault credential, and vault are deleted. Nothing was retried or
approved. The passing report is
`tmp/openai-agents-api/paid-requests/7d9577ab-966a-4a76-88d6-be72d313ddb2.json`;
the additional read-only ledger and review verification uses the same path with
`-verification.json`.

Before this run, the example's unpaginated operator lifecycle-list reads were
raised from a 1 MiB to a 16 MiB bound, because staging's lists exceeded 3 MiB.
Other reads keep the 1 MiB bound. Regression tests confirm that payment evidence
after a large history still fails denial validation, and that oversized
responses still fail closed.

This run and its local checks used an isolated SDK 0.1.3 build matching staging,
with the current example changes: 213 core tests and 17 adapter tests passed,
with lint and type checks. The checkout's separate 0.1.4 manifest bump was left
in place. The example's version handling was then changed to follow the package
version and tested locally on 0.1.4. The hosted runs do not establish live 0.1.4
compatibility. Nothing was published or deployed.
