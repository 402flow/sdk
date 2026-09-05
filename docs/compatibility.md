# SDK Compatibility

This document defines the compatibility contract for `@402flow/sdk`. It covers
the `0.1.x` release line, currently `0.1.2`. Pin an exact version in production.

## Public API stability

The supported package entrypoint is:

```ts
import { AgentPayClient } from '@402flow/sdk';
```

The root package is ESM-only. The `exports` map, exported TypeScript names,
discriminant values, and serialized request and response fields are public API.
Deep imports from `dist/` are not public API.

The official adapter package has separate provider entrypoints:

```ts
import { createDexterExecutor } from '@402flow/sdk-third-party-executors/dexter';
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
```

Keep `@402flow/sdk` and `@402flow/sdk-third-party-executors` on the exact same
version. The adapter package uses an exact SDK peer dependency.

## Error taxonomy

Paid decision outcomes throw `FetchPaidError`. Read `error.kind` or
`error.details.kind` before using outcome-specific fields.

| Kind | Meaning | Funds might have moved |
| --- | --- | --- |
| `denied` | Policy blocked execution before payment | No |
| `preflight_failed` | No usable payment rail or payment setup failed | Normally no |
| `execution_pending` | The idempotent operation is still running | Possibly |
| `execution_failed` | Paid execution started and ended in a hard failure | Possibly |
| `paid_fulfillment_failed` | Payment succeeded but merchant fulfillment failed | Yes |
| `execution_inconclusive` | The control plane cannot prove a final outcome | Possibly |
| `request_failed` | The control-plane response failed or did not match the SDK contract | Unknown |

Not every failure is a `FetchPaidError`:

- Merchant probe timeouts and aborts are platform errors. For example,
  `AbortSignal.timeout()` rejects with a `DOMException` named `TimeoutError`.
- Runtime-token exchange failures and control-plane transport failures are
  ordinary `Error` instances.
- `AgentHarness` converts its local state errors into
  `harnessDisposition: 'rejected'` results instead of throwing.

Handle platform cancellation before treating an error as an unknown SDK defect:

```ts
try {
  // Call fetchPaid() or preparePaidRequest().
} catch (error) {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    // The current network operation timed out.
  } else if (error instanceof FetchPaidError) {
    console.error(error.kind, error.reason);
  } else {
    throw error;
  }
}
```

## Semver boundaries

The current release has no prerelease suffix, but the package remains pre-1.0.
Until `1.0.0`:

- Pin exact versions.
- Treat changes to exported types, discriminants, package entrypoints, required
  request fields, and error fields as breaking changes.
- Release the SDK and official adapter package in lockstep.
- For alpha prereleases, do not infer compatibility between different alpha
  versions from npm's default prerelease range behavior.

After 1.0, additive optional fields and new error reason codes can ship in a
minor release. Removing or renaming exports, fields, discriminants, protocols,
or runtime entrypoints requires a major release.

## Runtime and TypeScript compatibility

The supported runtime floor is Node 20. CI runs the full SDK and adapter suite
on Node 20 and Node 22.

The package is ESM-only and uses NodeNext-compatible declarations. The repository
tests TypeScript 5.8 and currently develops with TypeScript 5.9. Consumers need
the `DOM` library types because the API uses `fetch`, `RequestInit`, `Response`,
and `AbortSignal`.

Recommended compiler settings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "lib": ["ES2022", "DOM"]
  }
}
```

## Request and response contracts

Paid request bodies must be replayable. Use a string or `URLSearchParams`.
`createJsonRequestBody()` and `createFormUrlEncodedBody()` create supported
bodies. `FormData`, `Blob`, and streams are not supported in paid flows.

`fetchPaid()` returns only:

- `kind: 'passthrough'` when the merchant did not require payment.
- `kind: 'success'` when paid fulfillment succeeded.

All paid non-success outcomes throw `FetchPaidError`. Narrow `result.kind`
before reading `receiptId`, `paidRequestId`, `paymentAttemptId`, or `receipt`.

`preparePaidRequest()` returns a serializable request. It preserves URL, method,
headers, body, and the merchant challenge. It does not preserve the original
`AbortSignal`. `executePreparedRequest()` reconstructs the exact serializable
request and does not probe the merchant again.

The SDK validates control-plane responses at runtime. A response that does not
match the exported Zod contract becomes `FetchPaidError` with
`kind: 'request_failed'`.

## Safe retries

Set an `idempotencyKey` before retrying any paid operation. Reuse the same key
only for the same URL, method, body, agent identity, and business operation.
Changing the request while reusing a key is a caller error.

| Result or error | Retry guidance |
| --- | --- |
| Merchant probe abort before a challenge | Retry if the merchant route is safe to probe |
| `denied` | Do not retry until policy or approval state changes |
| `preflight_failed` | Fix the reported rail, funding, or configuration problem first |
| `execution_pending` | Do not create a new key; retry or reconcile with the same key |
| `execution_failed` | Do not retry blindly; inspect the reason and payment attempt |
| `paid_fulfillment_failed` | Payment occurred; do not pay again without an explicit merchant recovery plan |
| `execution_inconclusive` | Reconcile first; never switch to a new key to force another payment |
| `request_failed` or transport loss | Retry with the same key because the server may have received the first request |

`AgentHarness` shares concurrent execution calls for one `preparedId`. After an
execution is consumed, prepare again for an explicit retry. Carry the original
business idempotency key into that retry.

The original `RequestInit.signal` controls the merchant probe. It does not define
a whole-operation deadline after paid execution starts. To bound every network
call, supply a custom `fetch` in `AgentPayClientOptions`. See
[`examples/typescript/timeout-client.ts`](../examples/typescript/timeout-client.ts).
A per-call timeout is not proof that payment did not happen.

## Older x402 behavior

The SDK accepts these merchant challenge forms:

- x402 v2 `PAYMENT-REQUIRED` headers with CAIP-2 network identifiers and
  `amount`.
- x402 v1-style JSON payloads that use `maxAmountRequired`.
- Legacy `X-PAYMENT-*` headers.
- `WWW-Authenticate` challenges that identify `x402`.
- JSON-body challenges when the response content type is JSON.

The SDK preserves legacy network aliases such as `base-sepolia`; it does not
silently rewrite them to CAIP-2 identifiers. Control-plane compatibility must
support the identifier the merchant supplied.

Migration tests live in
[`test/x402-migration.test.ts`](../test/x402-migration.test.ts). Add a fixture
before changing challenge detection, amount selection, network handling, or
header precedence.

## Hosted demo contract

The customer smoke test checks the public Base Sepolia and Solana devnet routes:

```bash
npm run smoke:hosted-demo
```

Each route must return HTTP 402, a valid x402 v2 `PAYMENT-REQUIRED` header, at
least one accepted payment method, and a challenge resource URL that exactly
matches the external HTTPS request URL. The smoke test does not submit payment.
