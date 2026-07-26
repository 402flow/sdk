import {
  FetchPaidError,
  createJsonRequestBody,
} from '@402flow/sdk';

import { createClient, demoMerchant, requiredEnv } from './shared.js';

const client = createClient();

try {
  const result = await client.fetchPaid(
    demoMerchant.baseSepolia,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createJsonRequestBody({
        topic: 'sdk integration rollout',
        audience: 'platform engineers',
        format: 'bullets',
      }),
    },
    {
      description: 'generate a Base Sepolia research brief',
      idempotencyKey: requiredEnv('X402FLOW_IDEMPOTENCY_KEY'),
    },
  );

  const merchantBody: unknown = await result.response.json();

  if (result.kind === 'passthrough') {
    console.log({ kind: result.kind, merchantBody });
  } else {
    console.log({
      kind: result.kind,
      receiptId: result.receiptId,
      receiptStatus: result.receipt.status,
      merchantBody,
    });
  }
} catch (error) {
  if (error instanceof FetchPaidError) {
    console.error({
      kind: error.kind,
      reason: error.reason,
      paidRequestId: error.paidRequestId,
      paymentAttemptId: error.paymentAttemptId,
      receiptId: error.receiptId,
      policyReviewEventId: error.policyReviewEventId,
    });
  } else {
    throw error;
  }
}
