import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentPayClient, FetchPaidError } from '@402flow/sdk';
import { createSandboxFetch } from './sandbox-probe.js';
import {
  digest,
  controlPlaneBaseUrl,
  paidRequestOutcomeSchema,
  validateCheckpoint,
  type PaidRequestOutcome,
} from './paid-request-contract.js';
import { ProbeError, requestText } from './transport.js';

// Both local tests and the hosted process use the real SDK. This transport only
// accepts SDK decision/receipt routes on the host to which the vault is scoped.
export function createExecutionFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const parsed = new URL(url);
    if (
      !(
        (url === `${controlPlaneBaseUrl}/api/sdk/payment-decisions` &&
          init?.method === 'POST') ||
        (parsed.origin === controlPlaneBaseUrl &&
          !parsed.search &&
          !parsed.hash &&
          /^\/api\/sdk\/receipts\/[0-9a-f-]{36}$/.test(parsed.pathname) &&
          (!init?.method || init.method === 'GET'))
      )
    )
      throw new ProbeError('paid_request_unexpected_sdk_route');
    const response = await requestText(
      fetchImpl,
      url,
      init ?? {},
      30_000,
      262_144,
    );
    return new Response(response.text, {
      status: response.status,
      headers: response.headers,
    });
  };
}
export async function executeCheckpoint(
  value: unknown,
  placeholder: string,
  fetchImpl: typeof fetch,
): Promise<PaidRequestOutcome> {
  const checkpoint = validateCheckpoint(value);
  if (!placeholder) throw new ProbeError('paid_request_missing_runtime_placeholder');
  const client = new AgentPayClient({
    controlPlaneBaseUrl,
    ...checkpoint.identity,
    auth: { type: 'runtimeToken', runtimeToken: placeholder },
    fetch: createExecutionFetch(fetchImpl),
  });
  let known: Partial<PaidRequestOutcome> = {};
  try {
    const result = await client.executePreparedRequest(
      checkpoint.prepared,
      checkpoint.context,
    );
    if (result.kind !== 'success')
      throw new ProbeError('paid_request_expected_paid_success');
    known = {
      paidRequestId: result.paidRequestId,
      paymentAttemptId: result.paymentAttemptId,
      receiptId: result.receiptId,
    };
    const body = await result.response.text();
    const receipt = await client.lookupReceipt(result.receiptId);
    return {
      kind: 'success',
      paidRequestId: result.paidRequestId,
      paymentAttemptId: result.paymentAttemptId,
      receiptId: result.receiptId,
      responseStatus: result.response.status,
      bodySha256: digest(body),
      receiptVerified:
        receipt.receipt.paidRequestId === result.paidRequestId &&
        receipt.receipt.paymentAttemptId === result.paymentAttemptId &&
        receipt.receipt.organizationId === checkpoint.config.organizationId &&
        receipt.receipt.agentId === checkpoint.config.agentId,
    };
  } catch (error) {
    if (error instanceof FetchPaidError) {
      return {
        ...known,
        kind: paidRequestOutcomeSchema.shape.kind.parse(error.kind),
        ...(error.paidRequestId ? { paidRequestId: error.paidRequestId } : {}),
        ...(error.paymentAttemptId
          ? { paymentAttemptId: error.paymentAttemptId }
          : {}),
        ...(error.receiptId ? { receiptId: error.receiptId } : {}),
        ...(error.policyReviewEventId
          ? { policyReviewEventId: error.policyReviewEventId }
          : {}),
      };
    }
    // A lost response or a failed receipt lookup may follow a settled payment.
    // Keep the durable operation for reconciliation; never retry here.
    return { ...known, kind: 'request_failed' };
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const transport = await createSandboxFetch(await import('undici'));
    try {
      const checkpoint: unknown = JSON.parse(
        await readFile('/workspace/checkpoint.json', 'utf8'),
      );
      const outcome = await executeCheckpoint(
        checkpoint,
        process.env.X402FLOW_RUNTIME_TOKEN ?? '',
        transport.fetch,
      );
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    } finally {
      await transport.close();
    }
  } catch {
    process.stderr.write('paid_request_sandbox_failed\n');
    process.exitCode = 1;
  }
}
