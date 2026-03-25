# @402flow/sdk

Node.js SDK for making paid requests through the 402flow control plane.

## Install

```bash
npm install @402flow/sdk
```

## Usage

### Runtime Token

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
	controlPlaneBaseUrl: 'https://402flow.ai',
	auth: {
		type: 'runtimeToken',
		runtimeToken: process.env.AGENT_PAY_RUNTIME_TOKEN ?? '',
	},
});
```

### Bootstrap Key

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
	controlPlaneBaseUrl: 'https://402flow.ai',
	auth: {
		type: 'bootstrapKey',
		bootstrapKey: process.env.AGENT_PAY_BOOTSTRAP_KEY ?? '',
	},
});
```

When you configure `bootstrapKey` auth, the SDK exchanges that credential for a runtime token and reuses the runtime token for subsequent control-plane calls until it needs refresh.

## Receipt Semantics

Receipt-bearing outcomes expose caller-visible finality directly on `receipt`.

Key fields:

1. `receipt.status`: `confirmed`, `provisional`, `refunded`, or `void`
2. `receipt.reconciliationStatus`: optional diagnostic progress about settlement attribution when the control plane has it
3. `receipt.canonicalSettlementKey`: present when the control plane has a stronger canonical settlement identity
4. `receipt.supersededByReceiptId`: present when a provisional receipt has later been replaced by a successor receipt

Interpretation rules:

1. a `success` result can still carry a provisional receipt if the merchant response was delivered but settlement attribution remains ambiguous
2. a `paid_fulfillment_failed` result can also carry a provisional receipt when payment was supportable but fulfillment failed
3. deterministic replay preserves the durable paid outcome instead of degrading a previously delivered response into a generic failure
4. callers should treat provisional receipts as real paid-attempt evidence, but not as proof of uniquely attributed final settlement
5. the SDK surfaces caller-visible receipt truth; it does not assume any dedicated reconciliation queue or operator workflow exists

## Runtime Requirements

Use this SDK from modern Node.js environments with built-in `fetch` support.

That matters because the SDK uses the Fetch API directly, not only when it calls `fetchPaid()`, but also when it normalizes headers and constructs response objects while mapping control-plane decisions back into SDK results. In practice, the SDK expects `fetch`, `Headers`, and `Response` to be available in the runtime.

The current target is modern Node.js with built-in Fetch API support.

## Repository Layout

This repository is a single-package npm repo. The public consumer surface is the package `@402flow/sdk`.

## Publish

The package is published from the repository root.
