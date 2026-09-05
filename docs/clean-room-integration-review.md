# Clean-room SDK Integration Review

Original clean-room review date: 2026-07-26

Current source review update: 2026-09-05, SDK and adapter `0.1.2`.

## Current 0.1.2 status

Both package manifests and the adapter's exact SDK peer dependency are aligned
at `0.1.2`. On Node 22.22.1 under WSL with TypeScript 5.9.3,
`npm run check:all` passed lint, typechecking, 93 core tests, and 17 adapter tests.
After the dependency update, these checks passed again, along with
`npm run pack:check` and `npm --prefix third-party-executors run pack:check`.
The production-only core audit reports zero findings.

Since the original review, `AgentHarness` has added explicit preparation
lineages: revisions supersede preparations in the same lineage, while unrelated
requests to the same endpoint remain independently executable. Delegated result
schemas also accept optional executor-reported payment terms for control-plane
comparison with the authorization snapshot. These changes are included in the
current source checks.

This update validates the current source checkout. The published-package,
TypeScript 5.8, hosted merchant, and paid campaign results below are
historical evidence from the original review; they were not rerun for this
update and do not establish a fresh `0.1.2` release campaign pass.

Funded Dexter mainnet settlement remains intentionally deferred. On 2026-09-05,
the user confirmed that they do not intend to fund a Dexter wallet with real
money yet. This is an accepted verification boundary, not an outstanding action
for this review.

### Current adapter dependency findings

After dependency remediation on 2026-09-05,
`npm --prefix third-party-executors audit --omit=dev` reports five high and two
moderate findings (down from six high and two moderate):

- Five high findings remain on the Dexter/Solana path to `bigint-buffer`, with
  no fix reported by npm.
- Two moderate findings affect `stream-json` and its dependent `jayson` through
  `@solana/web3.js`.

The adapter lockfile now resolves `fast-uri` to `3.1.7`, up from `3.1.4`, within
`ajv`'s existing dependency range. Its high finding is cleared. Regenerating the
lockfile also corrected its stale root SDK peer metadata from `0.1.1` to `0.1.2`,
matching the adapter manifest. This lockfile update controls repository installs;
it does not force existing consumer lockfiles to update transitive dependencies.

The `stream-json`/`jayson` findings remain open despite npm reporting a fix
available. The latest `jayson` (`4.3.0`) requires `stream-json` `^1.9.1` and uses
CommonJS paths such as `stream-json/streamers/StreamValues`. The patched
`stream-json` line starts at `3.5.0`; the current `3.6.0` uses ESM and different
exported paths. It is not a compatible transitive override. No forced upgrade
or downgrade was applied.

The [stream-json advisory](https://github.com/advisories/GHSA-528h-pc64-c93x)
concerns path filters and explicitly excludes `StreamValues`. The inspected
`jayson` `parseStream` implementation uses `StreamValues` and `Verifier`, not
those filters. That call path therefore does not appear affected by this
specific advisory; the audit findings remain visible pending an upstream fix.

A direct npm metadata check confirmed that Dexter's `latest` tag is still
`5.4.2`; `next` is `6.0.0-rc.5`. The prerelease still depends on
`@solana/spl-token` (`^0.4.9`). Its latest release, `0.4.15`, depends on
`@solana/buffer-layout-utils` (`^0.3.0`), whose latest release still depends on
`bigint-buffer` (`^1.1.5`). The prerelease therefore does not remove this path.
It also requires Node 22, which conflicts with the adapter's Node 20.18 support.
See the [Dexter versions](https://www.npmjs.com/package/@dexterai/x402?activeTab=versions)
and [bigint-buffer advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg).

Keep the tested Dexter pin for now. Removing the provider dependency tree from
pay.sh-only installations remains a possible future breaking packaging change,
as described in the [adapter guide](../third-party-executors/README.md#dependency-footprint).

## Original review baseline

- `@402flow/sdk@0.1.0-alpha.30` from npm
- `@402flow/sdk-third-party-executors@0.1.0-alpha.30` from npm
- Node 22.22.1 in Ubuntu under WSL
- TypeScript 5.8.2 and 5.9.3
- Strict `NodeNext` compilation

The review started from the README returned by
`npm view @402flow/sdk readme`. The published package and hosted merchant were
treated as black boxes until a documented failure or ambiguity required source
inspection.

## Original review disposition

Pass with documented third-party limitations.

The core SDK passed clean-room Base Sepolia, Base mainnet, Solana devnet, and
Solana mainnet payments, idempotent retries, prepared execution, `AgentHarness`,
strict TypeScript, legacy x402 fixtures, and both official adapter suites.

The hosted demo merchant is release-ready for SDK integration testing. Three
consecutive testnet smoke runs returned valid x402 v2 challenges with exact
external HTTPS resource URLs. The expanded smoke now validates all four hosted
routes. Fresh native SDK fulfillment returned HTTP 200 on Base Sepolia and
Solana devnet. A subsequent `scenario:all` run passed all 21 scenarios,
including three paid Base mainnet and three paid Solana mainnet fulfillments.

The reviewed `0.1.1` candidate subsequently upgraded the adapter from
`@dexterai/x402` 3.9.1 to the exact 5.4.2 release. The adapter still passes all
17 tests, typecheck, build, and dry-pack checks. The production-only audit
reports five high findings on one unresolved path:
`@dexterai/x402` → `@dexterai/vault`/`@solana/spl-token` →
`@solana/buffer-layout-utils` → `bigint-buffer`.
The core SDK itself depends only on Zod and reports zero audit findings.

## Clean-room results

| Area | Result | Evidence |
| --- | --- | --- |
| `fetchPaid` | Pass after documentation fix | Solana devnet returned success; exact retry reused the paid request, payment attempt, and receipt |
| Prepare and execute | Pass | Base Sepolia prepared as `ready/execute`; exact retry reused the same receipt |
| `AgentHarness` | Pass | Concurrent execute calls shared one result; lookup returned stored output; a later execute was rejected as consumed |
| Base flow | Pass | Hosted Base Sepolia and three Base mainnet payments returned fulfilled HTTP 200 responses with receipts |
| Solana flow | Pass | Hosted Solana devnet and three Solana mainnet payments returned fulfilled HTTP 200 responses with receipts |
| Third-party executor | Pass with documented boundary | Dexter and pay.sh typechecks, 17 tests, build, and help paths passed; Dexter reached live authorization and returned a typed preflight failure for unsupported hosted testnets |
| Abort signals | Pass with documented boundary | Probe aborts preserve platform errors; prepared execution does not retain the original signal |
| Timeouts | Pass with documented boundary | Per-call custom fetch pattern covers merchant and control-plane calls |
| Retry and idempotency | Pass | Hosted exact retries reused receipts; contract tests verify key forwarding and no hidden automatic retry |
| Policy denials | Pass | Existing public integration fixtures produce typed `FetchPaidError` denial results |
| Payment failures | Pass | Preflight, execution failure, pending, and inconclusive fixtures remain typed |
| Paid fulfillment failures | Pass | Receipt-backed fulfillment failure fixtures remain typed |
| TypeScript ergonomics | Pass after README fix | Strict TypeScript 5.8 and 5.9 compile the executable examples |
| Hosted merchant | Pass | All four challenge contracts passed; paid fulfillment passed on both testnets and both mainnets |

Both live devnet receipts were provisional. This matches the documented receipt
contract and must not be presented as final chain settlement proof.

## Friction ledger

### CL-001: Published `fetchPaid` example did not type-check

The README accessed `result.receiptId` without narrowing `PaidResponse`.
`PassthroughPaidResponse` has no receipt. The example now branches on
`result.kind`, and strict executable examples are part of typechecking.

### CL-002: Hosted challenges downgraded HTTPS resource URLs

Both documented test routes returned HTTP 402 with valid x402 v2 data, but
`challenge.resource.url` used `http://` for an HTTPS request. Client-side
rewriting would have hidden an origin-integrity defect, so the SDK did not
rewrite it. The merchant proxy fix now preserves the exact externally visible
HTTPS URL, as verified by `npm run smoke:hosted-demo`.

### CL-011: Hosted merchant availability regression was resolved

The first post-deployment smoke returned valid 402 challenges with exact HTTPS
resource URLs on both routes. A later deployment returned HTTP 503 with an nginx
HTML body on both routes. After the merchant fix, three consecutive smoke runs
and fresh paid fulfillment on both networks passed. The smoke test remains as a
regression check; retries must not hide future availability failures.

### CL-012: Dexter 5.4.2 does not resolve the hosted test networks

The Dexter ESM client loaded, the SDK prepared the live challenge, and the
control plane authorized delegated execution. Dexter then returned
`no_payment_options` before signing because its public network resolver does not
map Base Sepolia (`eip155:84532`) or Solana devnet. `detectStrategy()` recognizes
the v2 challenge but produces no payable options, and `toNetworkRef()` returns
`null` for both hosted test networks.

The adapter normalizes this result to a typed `preflight_failed` outcome with
`preflight_incompatible`; a regression test now protects that behavior. No
signature or transaction was submitted. Dexter resolves the corresponding
mainnet networks, but a funded mainnet-wallet settlement was explicitly waived
for this review.

### CL-013: Dexter's CommonJS entry path does not load in this dependency graph

A direct CommonJS `createRequire()` probe failed with
`ERR_PACKAGE_PATH_NOT_EXPORTED` while resolving `@dexterai/x402-core`. The
supported ESM import path works and is what this ESM-only adapter uses. CommonJS
provider loading is therefore an upstream Dexter packaging limitation, not a
supported adapter runtime.

### CL-014: Hosted mainnet coverage was hidden in the scenario suite

The repository had Base and Solana mainnet harness fixtures, but the package
README and hosted smoke command listed only testnets. The release disposition
also did not include mainnet payment evidence. The README and smoke contract now
cover all four hosted routes, and the scenario guide defines `scenario:core` as
the default paid release campaign.

The 2026-07-26 `scenario:all` run passed all six mainnet scenarios with HTTP 200
fulfillment, receipt IDs, paid-request IDs, payment-attempt IDs, and stored
`AgentHarness` results. Its representative ready-path receipts were
`127f9769-9473-4be7-8701-c4853fd8ca69` on Base and
`1f06366b-ff5c-4a77-81c9-5fea39db7393` on Solana.

Public mainnet RPC verification confirmed the representative Base transaction
`0x4c703997425e8c30265075ca0d0eb3beee0405f2e33e1174cdb4f01f35caa48d`
succeeded with receipt status `0x1` in block `0x2ee2114`. The representative
Solana signature
`4RSCrujm68zB9Yt8qxjYPG5yBdkc4ZN5GfQmFCwmNkp6NfjUNq6YPcGgZBfAhUHBcqYX1QTQ1otb5R7LsfaadDRW`
was finalized without error in slot `435431184`.

### CL-003: The README omitted the Base integration route

The detailed guide named Base Sepolia, but the package front door named only
Solana devnet. The README now lists both side-effect-free test routes, their
price, and the mainnet warning.

### CL-004: Abort behavior was undocumented

Merchant probe timeouts reject with the platform `TimeoutError`. An
already-aborted signal rejects with the caller's reason. These failures are not
`FetchPaidError`.

### CL-005: Prepared execution has no original-signal deadline

Prepared state is serializable and does not retain `AbortSignal`.
`executePreparedRequest()` reconstructs the request. The docs now define this
boundary and show a custom fetch that applies a timeout to each network call.

### CL-006: Failure examples were not reproducible from customer docs

The guides listed paid failure kinds but did not provide an executable contract
or retry table. The compatibility guide now defines the taxonomy, and tests
cover transport loss, aborts, idempotency, policy failures, payment failures,
and paid fulfillment failures.

### CL-007: One transient Base preparation returned passthrough

The first combined live run returned `passthrough/treat_as_passthrough` for Base
after a raw 402 probe. Two isolated preparations, a cross-network preparation,
and an exact rerun all returned `ready/execute`. This is recorded as a
non-reproducible hosted observation, not an SDK defect.

### CL-008: Official adapter documentation stopped at imports

The published docs did not show constructor options, provider credential setup,
or how to attach an executor to prepared execution. The adapter guide now
documents these inputs and links to complete executable examples.

### CL-009: Provider subpaths did not reduce installed dependencies

Subpath imports prevent the unused provider from loading and help bundlers, but
npm still installs both declared provider trees. The documentation now states
this directly.

### CL-010: Published adapter metadata referenced the previous SDK

The alpha.30 adapter had an alpha.30 exact peer but an alpha.29 SDK development
dependency. Package metadata and the lockfile are aligned, and a contract test
now enforces lockstep.

## Source inspection ledger

### INS-001: Published declaration and accidental implementation search

After CL-001, the review inspected
`node_modules/@402flow/sdk/dist/index.d.ts` lines 60-155 to identify the
`PaidResponse.kind` discriminants. A broad search also returned matching lines
from published `dist/index.js`. The output exposed conditional receipt mapping
and conditional harness receipt inclusion; no implementation range was opened
at that stage.

### INS-002: Core prepare, execute, and fetch flow

Inspected `src/index.ts` lines 1410-1795 and 1935-2165 after CL-004 through
CL-006. This established signal lifetime, prepared request serialization,
control-plane endpoints, runtime-token behavior, and `FetchPaidError`
normalization.

### INS-003: Challenge compatibility

Inspected `src/challenge-detection.ts` and its test file after customer docs did
not define the older x402 boundary. This led to migration tests for v1
`maxAmountRequired`, legacy `X-PAYMENT-*` headers, and current v2
`PAYMENT-REQUIRED` challenges.

### INS-004: Public and integration tests

Inspected `test/public-api.test.ts`, the integration test inventory, and targeted
failure test locations. This avoided duplicating existing outcome fixtures and
identified missing cancellation, retry, documentation, and version-lockstep
coverage.

### INS-005: Official adapter implementation and examples

Inspected `third-party-executors/src/dexter-executor.ts`,
`third-party-executors/src/index.ts`, the published adapter declarations, and
both adapter examples after CL-008 and CL-009. This established the real
constructor contract, lazy runtime loading, and npm install behavior.

### INS-006: Build, package, and CI configuration

Inspected both package manifests, TypeScript configs, the release guide, and the
Node 20/22 CI workflow to define runtime, TypeScript, entrypoint, and lockstep
boundaries.

### INS-007: Dexter live compatibility boundary

After the funded-wallet test was waived, the review exercised Dexter 5.4.2
against the live hosted challenges and inspected its public `detectStrategy()`
and `toNetworkRef()` results. This isolated the testnet resolver boundary from
wallet funding and led to CL-012 and executable normalization coverage.

## Formal compatibility review

### Public API stability

The root ESM entrypoint and current discriminated unions are coherent. Public
stability tests cover the client, harness, body helpers, schemas, and version
header. Deep `dist/` imports remain unsupported.

Risk at the original review: `0.1.1` was an early stable-tag release. Exact version pinning remains
recommended until consumers have validated their integration.

### Error taxonomy

Paid outcomes have a useful typed taxonomy. The remaining setup and transport
errors intentionally use platform `Error` types. The compatibility guide now
explains the boundary instead of implying one universal SDK error base class.

### Semver boundaries

The exact adapter peer dependency is appropriate for the lockstep `0.1.x` line.
Version lockstep is tested. Provider dependency restructuring must wait for a
breaking release.

### Runtime and TypeScript compatibility

CI covers Node 20 and Node 22. A separate matrix compiles the SDK, executable
examples, and adapters with TypeScript 5.8.2 and 5.9.3.

### Request and response contract drift

Runtime Zod validation protects control-plane responses. New tests protect
legacy and current merchant challenge shapes. The hosted origin and availability
regressions are fixed, and the executable smoke test protects the exact external
resource URL contract.

### Safe retry guidance

The compatibility guide now defines outcome-specific retry rules. The central
rule is to reuse one idempotency key for one exact business operation and never
create a new payment key merely to escape pending, inconclusive, or
receipt-backed fulfillment failure states.

### Migration tests for older x402 behavior

`test/x402-migration.test.ts` protects:

- v1 `maxAmountRequired`
- legacy network aliases
- legacy `X-PAYMENT-*` headers
- v2 `PAYMENT-REQUIRED` and CAIP-2 identifiers

## Original review verification

Completed:

- strict TypeScript 5.8.2 and 5.9.3
- root lint, typecheck, and 92 tests
- adapter lint, typecheck, and 17 tests
- root and adapter dry-pack builds
- Dexter and pay.sh example help paths
- live Base Sepolia, Base mainnet, Solana devnet, and Solana mainnet payments
- live exact-key retry and `AgentHarness` reuse
- three consecutive hosted testnet challenge checks
- four-route hosted challenge contract coverage
- fresh hosted Base Sepolia and Solana devnet paid fulfillment
- a passing 21-scenario `scenario:all` campaign
- three successful Base mainnet and three successful Solana mainnet paid
  fulfillments with HTTP 200, receipts, and stored harness results
- Dexter 5.4.2 ESM live preparation and authorization through its unsupported
  testnet preflight boundary

Outstanding:

- the combined adapter package retains the documented Dexter dependency audit
  exposure

Accepted limitation:

- a funded Dexter mainnet settlement was intentionally not run; Dexter 5.4.2
  cannot use the hosted Base Sepolia or Solana devnet challenges, and the review
  stops at the verified typed preflight boundary
