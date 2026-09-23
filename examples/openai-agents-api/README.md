# OpenAI Agents API: Stage 1 capability probe

This SDK-owned example checks hosted execution using an **inert, random canary**.
It does not exchange 402flow credentials, evaluate policy, or execute payments.
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
Local checks passed: 133 core tests (including 40 focused probe/transport tests), 17
adapter tests, and lint/type checks for both packages. Tests use simulated
provider records and the actual local 402flow SDK.
The public canary receiver was deployed and verified on 2026-09-23 UTC. Its
empty/supplied-header hashes, no-echo/no-store behavior, and rejected requests
passed live HTTPS checks. The SDK-local configuration now contains its URL.
**Live hosted Stage 1 passed on 2026-09-23 UTC** with `gpt-6-luna`, hosted Node
22.23.2, SDK 0.1.2, and Undici 6.28.1. The root and two distinct direct subagents
passed all seven checks each. The report is
`tmp/openai-agents-api/hosted-20260923-proxy.json`; all three disposable provider
resources were deleted and no creation is unresolved. Staging was awakened
through its existing controller with explicit operator authorization.

Two earlier attempts failed command validation. Diagnostic evidence exposed the
executor's shell wrapper and failed direct Node networking; the exact wrapper
and proxy transport fixes are covered by regression tests. All resources from
those attempts were also deleted. No real 402flow credential or payment was used.
Both package dry-run checks passed; no package was published.

## Commands and configuration

Run from the SDK root with its Linux Node/npm toolchain (Node 20+). Install the
repository's existing dependencies. The commands compile the example with the
existing TypeScript dependency. Generated files stay in ignored `dist/`.

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

- Node supports the SDK, and pinned `@402flow/sdk@0.1.2` loads.
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
the credential allowlist contains only the receiver. Package installation uses
the provider's pinned npm setup. Installation failure is a failed gate; never
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

## Later payment recovery

Stage 1 implements provider resource checkpointing and cleanup only. The later
paid example must use **prepare → durable checkpoint → execute** even for its
first purchase. The trusted SDK-side caller must persist the exact serialized
prepared request and challenge, input fingerprint, authenticated identity, and
stable business idempotency key outside the hosted sandbox before execution.
Execute only `kind === 'ready'` with `nextAction === 'execute'` after that durable
acknowledgement. `AgentHarness` memory and sandbox files are not durable stores.

After a lost response, reconcile the existing operation using that checkpoint;
do not re-probe or switch keys. Preserve the outcome-specific
[SDK retry rules](../../docs/compatibility.md#safe-retries). Denials and policy
review are terminal for the old request; paid fulfillment failures need explicit
merchant recovery. No new authorization, renewal, delegation, or payment APIs
are introduced by this example.

## Local checks

```bash
npm test -- --run test/openai-agents-api.test.ts
npm run check:all
npm run example:openai-agents-api -- plan
```

`check:all` runs lint, type checks, and tests for both the core and adapter. The
focused tests require a compiler subprocess, but no external
network, OpenAI key, hosted session, or paid request. They are local evidence,
not a replacement for hosted acceptance.
