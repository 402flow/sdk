# Clean-room SDK Integration Review

Review date: 2026-07-26

Baseline:

- `@402flow/sdk@0.1.0-alpha.30` from npm
- `@402flow/sdk-third-party-executors@0.1.0-alpha.30` from npm
- Node 22.22.1 in Ubuntu under WSL
- TypeScript 5.8.2 and 5.9.3
- Strict `NodeNext` compilation

The review started from the README returned by
`npm view @402flow/sdk readme`. The published package and hosted merchant were
treated as black boxes until a documented failure or ambiguity required source
inspection.

## Disposition

Conditional pass.

The core SDK passed clean-room Base Sepolia and Solana devnet payments,
idempotent retries, prepared execution, `AgentHarness`, strict TypeScript,
legacy x402 fixtures, and both official adapter suites.

The hosted demo merchant is not release-ready. Both test routes challenge an
external HTTPS request with an `http://` resource URL. The merchant deployment
must emit the externally visible HTTPS origin before the hosted smoke check can
pass.

The combined adapter package also has a large, provider-driven install surface.
The clean install produced 317 dependencies and 11 npm audit findings. All
reported findings traced through the Dexter dependency tree. The core SDK itself
depends only on Zod.

The reviewed `0.1.0` candidate subsequently upgraded the adapter from
`@dexterai/x402` 3.9.1 to the exact 5.4.2 release. The adapter still passes all
16 tests, typecheck, build, and dry-pack checks. The production-only audit now
reports five high findings on one unresolved path:
`@dexterai/x402` → `@dexterai/vault`/`@solana/spl-token` →
`@solana/buffer-layout-utils` → `bigint-buffer`.

## Clean-room results

| Area | Result | Evidence |
| --- | --- | --- |
| `fetchPaid` | Pass after documentation fix | Solana devnet returned success; exact retry reused the paid request, payment attempt, and receipt |
| Prepare and execute | Pass | Base Sepolia prepared as `ready/execute`; exact retry reused the same receipt |
| `AgentHarness` | Pass | Concurrent execute calls shared one result; lookup returned stored output; a later execute was rejected as consumed |
| Base flow | Pass | Hosted Base Sepolia payment and fulfillment returned HTTP 200 |
| Solana flow | Pass | Hosted Solana devnet payment and fulfillment returned HTTP 200 |
| Third-party executor | Pass with install warning | Dexter and pay.sh typechecks, unit tests, integration tests, build, and help paths passed |
| Abort signals | Pass with documented boundary | Probe aborts preserve platform errors; prepared execution does not retain the original signal |
| Timeouts | Pass with documented boundary | Per-call custom fetch pattern covers merchant and control-plane calls |
| Retry and idempotency | Pass | Hosted exact retries reused receipts; contract tests verify key forwarding and no hidden automatic retry |
| Policy denials | Pass | Existing public integration fixtures produce typed `FetchPaidError` denial results |
| Payment failures | Pass | Preflight, execution failure, pending, and inconclusive fixtures remain typed |
| Paid fulfillment failures | Pass | Receipt-backed fulfillment failure fixtures remain typed |
| TypeScript ergonomics | Pass after README fix | Strict TypeScript 5.8 and 5.9 compile the executable examples |
| Hosted merchant | Fail | Base Sepolia and Solana devnet challenge URLs downgrade HTTPS to HTTP |

Both live devnet receipts were provisional. This matches the documented receipt
contract and must not be presented as final chain settlement proof.

## Friction ledger

### CL-001: Published `fetchPaid` example did not type-check

The README accessed `result.receiptId` without narrowing `PaidResponse`.
`PassthroughPaidResponse` has no receipt. The example now branches on
`result.kind`, and strict executable examples are part of typechecking.

### CL-002: Hosted challenges downgrade HTTPS resource URLs

Both documented test routes returned HTTP 402 with valid x402 v2 data, but
`challenge.resource.url` used `http://` for an HTTPS request. Client-side
rewriting would hide an origin-integrity defect, so the SDK does not rewrite it.
`npm run smoke:hosted-demo` now fails on this mismatch.

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

## Formal compatibility review

### Public API stability

The root ESM entrypoint and current discriminated unions are coherent. Public
stability tests cover the client, harness, body helpers, schemas, and version
header. Deep `dist/` imports remain unsupported.

Risk: this is an alpha line. Exact version pinning is required.

### Error taxonomy

Paid outcomes have a useful typed taxonomy. The remaining setup and transport
errors intentionally use platform `Error` types. The compatibility guide now
explains the boundary instead of implying one universal SDK error base class.

### Semver boundaries

The exact adapter peer dependency is appropriate for the current alpha line.
Version lockstep is now tested. Provider dependency restructuring must wait for
a breaking release.

### Runtime and TypeScript compatibility

CI covers Node 20 and Node 22. A separate matrix compiles the SDK, executable
examples, and adapters with TypeScript 5.8.2 and 5.9.3.

### Request and response contract drift

Runtime Zod validation protects control-plane responses. New tests protect
legacy and current merchant challenge shapes. The hosted merchant's scheme drift
is the outstanding contract failure.

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

## Verification

Completed:

- strict TypeScript 5.8.2 and 5.9.3
- root lint, typecheck, and 91 tests
- adapter lint, typecheck, and 16 tests
- root and adapter dry-pack builds
- Dexter and pay.sh example help paths
- live Base Sepolia and Solana devnet payments
- live exact-key retry and `AgentHarness` reuse

Outstanding:

- `npm run smoke:hosted-demo` fails until the hosted merchant emits HTTPS
  resource URLs behind its reverse proxy
- the combined adapter package retains the documented Dexter dependency audit
  exposure
