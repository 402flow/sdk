# @402flow/sdk

Node.js SDK for making paid requests through the 402flow control plane.

## Install

```bash
npm install @402flow/sdk
```

## Usage

### Bootstrap Key

```ts
import { AgentPayClient } from '@402flow/sdk';

const client = new AgentPayClient({
	controlPlaneBaseUrl: 'https://402flow.ai',
	organization: 'acme-labs',
	agent: 'reporting-worker',
	auth: {
		type: 'bootstrapKey',
		bootstrapKey: process.env.AGENT_PAY_BOOTSTRAP_KEY ?? '',
	},
});
```


Create one `AgentPayClient` per agent identity. The client binds the organization and agent selectors up front, and `fetchPaid()` only carries request-specific context.
For most SDK integrations, `bootstrapKey` is the recommended auth mode. The SDK exchanges it for a short-lived runtime token, caches that token, and refreshes it automatically before expiry.

### fetchPaid()

Call `fetchPaid()` with the merchant URL, the outgoing request, and request-specific control-plane context.

```ts
try {
	const result = await client.fetchPaid(
		'https://merchant.example.com/reports/daily',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				date: '2026-03-25',
			}),
		},
		{
			description: 'sync daily paid report',
			idempotencyKey: 'daily-report-2026-03-25',
		},
	);
	const paidContent = await result.response.json();
	console.log('paid content:', paidContent);
} catch (error) {
	console.error('paid request failed', error);
	throw error;
}
```

### fetchPaid errors

`fetchPaid()` throws `FetchPaidError` for plocy denials and other failures:

1. `denied`: the control plane denied the paid request before execution becuase of a policy violation
2. `preflight_failed`: the request was incompatible with paid execution before payment started
3. `execution_pending`: a safe retry attached to an in-flight paid attempt that is still executing
4. `execution_failed`: payment failed, no receipt was produced, and no paid content was delivered
5. `paid_fulfillment_failed`: payment was accepted and a receipt exists, but the merchant did not deliver the paid content
6. `execution_inconclusive`: the system could not conclusively determine the payment outcome

## Receipt Semantics

`receipt.status = 'confirmed'` means the control plane has chain-backed settlement attribution for the paid attempt. `receipt.status = 'provisional'` means the paid outcome was supportable by merchant provided evidence, but final settlement attribution is still pending on-chain reconciliation.

## Notes

1. a `success` will always carry a receipt and the paid content
2. a `paid_fulfillment_failed` result will also carry a receipt when the merchant took payment but fulfillment failed
3. callers should treat provisional receipts as payment attempt evidence, not as proof of final settlement
4. later chain analysis in the control plane will advance a provisional receipt to confirmed, refunded, void, or expired
5. if you safely retry the same logical paid request with the same `idempotencyKey`, the SDK returns the same durable paid outcome and receipt instead of creating a second paid attempt

## Publish

```
npm install
npm run check
npm run pack:check
npm publish --access public
```
