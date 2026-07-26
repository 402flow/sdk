import {
  FetchPaidError,
  createJsonRequestBody,
} from '@402flow/sdk';

import { createClient, demoMerchant, requiredEnv } from './shared.js';

const client = createClient();
const prepared = await client.preparePaidRequest(
  demoMerchant.solanaDevnet,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: createJsonRequestBody({
      topic: 'sdk integration rollout',
      audience: 'platform engineers',
      format: 'bullets',
    }),
  },
);

if (prepared.nextAction === 'revise_request') {
  console.error(prepared.validationIssues);
} else if (prepared.nextAction === 'treat_as_passthrough') {
  console.log('The merchant did not require payment.');
} else if (prepared.kind === 'ready') {
  try {
    const result = await client.executePreparedRequest(prepared, {
      description: 'generate a Solana devnet research brief',
      idempotencyKey: requiredEnv('X402FLOW_IDEMPOTENCY_KEY'),
    });

    console.log({
      kind: result.kind,
      status: result.response.status,
      receiptId: result.kind === 'success' ? result.receiptId : undefined,
      merchantBody: await result.response.text(),
    });
  } catch (error) {
    if (error instanceof FetchPaidError) {
      console.error({ kind: error.kind, reason: error.reason });
    } else {
      throw error;
    }
  }
}
