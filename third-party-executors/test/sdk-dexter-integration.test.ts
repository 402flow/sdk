import { describe, expect, it, vi } from 'vitest';

import { AgentPayClient, FetchPaidError } from '@402flow/sdk';

import { createDexterExecutor } from '../src/dexter-executor.js';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const baseMoney = {
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '1.000000',
  amountMinor: '1000000',
  precision: 6,
  unit: 'minor' as const,
};

const baseReceipt = {
  receiptId: '00000000-0000-0000-0000-000000000030',
  paidRequestId: '00000000-0000-0000-0000-000000000130',
  paymentAttemptId: '00000000-0000-0000-0000-000000000230',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  merchantId: '00000000-0000-0000-0000-000000000003',
  protocol: 'x402' as const,
  money: baseMoney,
  authorizationOutcome: 'allowed' as const,
  status: 'confirmed' as const,
  reconciliationStatus: 'none' as const,
  requestUrl: 'https://merchant.example.com/data',
  requestMethod: 'POST' as const,
  createdAt: '2026-03-10T00:00:00.000Z',
};

const dexterWallets = {
  evm: {
    address: '0x1111111111111111111111111111111111111111',
    signTypedData: async () => '0xdeadbeef',
  },
};

function createDexterChallengeHeaders() {
  return {
    'payment-required': Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '1000000',
            asset: baseMoney.asset,
            payTo: '0xmerchant',
            extra: {
              precision: 6,
            },
          },
        ],
      }),
      'utf8',
    ).toString('base64'),
  };
}

async function prepareDexterReadyRequest(client: AgentPayClient) {
  const prepared = await client.preparePaidRequest(
    'https://merchant.example.com/paid',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    },
    {
      challenge: {
        protocol: 'x402',
        headers: createDexterChallengeHeaders(),
      },
    },
  );

  if (prepared.kind !== 'ready') {
    throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
  }

  return prepared;
}

describe('Dexter executor integration proof', () => {
  it('authorizes, delegates through Dexter, and finalizes against a mock merchant implementation', async () => {
    const originalFetch = globalThis.fetch;
    const dexterTransaction = '0xdexter-payment-1';
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000152',
              paymentAttemptId: '00000000-0000-0000-0000-000000000252',
              executionProvider: 'dexter',
              reasonCode: 'policy_allow',
              reason: 'Authorized for delegated execution.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(async (_input, init) => {
        const finalizationBody = JSON.parse(String(init?.body));

        expect(finalizationBody.result.executionStatus).toBe('succeeded');
        expect(finalizationBody.result.settlementEvidenceClass).toBe(
          'merchant_verifiable_success',
        );
        expect(finalizationBody.result.merchantOutcome).toBe('success_response');
        expect(finalizationBody.result.settlementReference).toBe(
          dexterTransaction,
        );
        expect(finalizationBody.result.paymentReference).toBe(
          dexterTransaction,
        );
        expect(finalizationBody.result.evidenceSource).toBe('merchant');
        expect(finalizationBody.result.signerSubmissionEvidence).toMatchObject({
          txHash: dexterTransaction,
          paymentReference: dexterTransaction,
        });
        expect(finalizationBody.result.merchantResponse).toMatchObject({
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-payment-response': Buffer.from(
              JSON.stringify({ transaction: dexterTransaction }),
              'utf8',
            ).toString('base64'),
          },
          body: '{"ok":true}',
        });

        return new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000152',
            paymentAttemptId: '00000000-0000-0000-0000-000000000252',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000152',
              paymentAttemptId: '00000000-0000-0000-0000-000000000252',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
    const merchantFetch = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        const headers = new Headers(init?.headers);

        if (headers.get('x-payment')) {
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-payment-response': Buffer.from(
                JSON.stringify({ transaction: dexterTransaction }),
                'utf8',
              ).toString('base64'),
            },
          });
        }

        return new Response(
          JSON.stringify({
            accepts: [
              {
                scheme: 'exact',
                network: 'base',
                amount: '1000000',
                asset: baseMoney.asset,
                payTo: '0xmerchant',
                extra: {
                  name: 'USD Coin',
                  version: '2',
                },
              },
            ],
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    );

    globalThis.fetch = merchantFetch;

    try {
      const client = new AgentPayClient({
        controlPlaneBaseUrl: 'http://localhost:3001',
        auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
        ...baseContext,
        fetch: controlPlaneFetch,
      });
      const prepared = await prepareDexterReadyRequest(client);

      const result = await client.executePreparedRequest(prepared, {
        executionProvider: 'dexter',
        executor: createDexterExecutor({
          wallets: dexterWallets,
        }),
      });

      expect(result.kind).toBe('success');
      expect(merchantFetch).toHaveBeenCalledTimes(2);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
      expect(
        new Headers(merchantFetch.mock.calls[1]?.[1]?.headers).get('x-payment'),
      ).toBeTruthy();
      expect(controlPlaneFetch.mock.calls[0]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-authorizations',
      );
      expect(controlPlaneFetch.mock.calls[1]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-finalizations',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces delegated authorization denials before invoking the provider executor', async () => {
    const controlPlaneFetch = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000153',
            reasonCode: 'policy_review_required',
            reason: 'Policy review required before delegated execution.',
            policyReviewEventId: '00000000-0000-0000-0000-000000000032',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const executor = {
      provider: 'dexter',
      execute: vi.fn(async () => ({
        protocol: 'x402' as const,
        executionStatus: 'succeeded' as const,
        settlementEvidenceClass: 'merchant_verifiable_success' as const,
        merchantOutcome: 'success_response' as const,
      })),
    };
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: controlPlaneFetch,
    });
    const prepared = await prepareDexterReadyRequest(client);

    const error = await client
      .executePreparedRequest(prepared, {
        executionProvider: 'dexter',
        executor,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('denied');
    expect(error.reason).toBe(
      'Policy review required before delegated execution.',
    );
    expect(error.policyReviewEventId).toBe(
      '00000000-0000-0000-0000-000000000032',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
    expect(controlPlaneFetch.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/sdk/payment-authorizations',
    );
  });

  it('finalizes delegated Dexter merchant rejections as execution failures', async () => {
    const originalFetch = globalThis.fetch;
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000154',
              paymentAttemptId: '00000000-0000-0000-0000-000000000254',
              executionProvider: 'dexter',
              reasonCode: 'policy_allow',
              reason: 'Authorized for delegated execution.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(async (_input, init) => {
        const finalizationBody = JSON.parse(String(init?.body));

        expect(finalizationBody.result.executionStatus).toBe('failed');
        expect(finalizationBody.result.settlementEvidenceClass).toBe('none');
        expect(finalizationBody.result.merchantOutcome).toBe('failure_response');
        expect(finalizationBody.result.diagnostic).toMatchObject({
          code: 'merchant_rejected',
          message: 'merchant HTTP 402: payment required',
        });
        expect(finalizationBody.result).not.toHaveProperty('merchantResponse');
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          dexter: {
            reason: 'merchant_rejected',
            detail: 'merchant HTTP 402: payment required',
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000154',
            paymentAttemptId: '00000000-0000-0000-0000-000000000254',
            reasonCode: 'merchant_rejected',
            reason: 'Merchant rejected the paid request.',
            merchantResponse: {
              status: 402,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"payment required"}',
            },
            evidence: {
              rejectionSource: 'merchant',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
    const merchantFetch = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        const headers = new Headers(init?.headers);

        if (headers.get('x-payment')) {
          return new Response(
            JSON.stringify({ error: 'payment required' }),
            {
              status: 402,
              headers: {
                'content-type': 'application/json',
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            accepts: [
              {
                scheme: 'exact',
                network: 'base',
                amount: '1000000',
                asset: baseMoney.asset,
                payTo: '0xmerchant',
                extra: {
                  name: 'USD Coin',
                  version: '2',
                },
              },
            ],
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    );

    globalThis.fetch = merchantFetch;

    try {
      const client = new AgentPayClient({
        controlPlaneBaseUrl: 'http://localhost:3001',
        auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
        ...baseContext,
        fetch: controlPlaneFetch,
      });
      const prepared = await prepareDexterReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'dexter',
          executor: createDexterExecutor({
            wallets: dexterWallets,
          }),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchPaidError);
      if (!(error instanceof FetchPaidError)) {
        throw error;
      }
      expect(error.kind).toBe('execution_failed');
      expect(error.reason).toBe('Merchant rejected the paid request.');
      expect(error.decision.reasonCode).toBe('merchant_rejected');
      expect(merchantFetch).toHaveBeenCalledTimes(2);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
      expect(
        new Headers(merchantFetch.mock.calls[1]?.[1]?.headers).get('x-payment'),
      ).toBeTruthy();
      expect(controlPlaneFetch.mock.calls[0]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-authorizations',
      );
      expect(controlPlaneFetch.mock.calls[1]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-finalizations',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('finalizes delegated Dexter post-payment transport errors as inconclusive transport loss', async () => {
    const originalFetch = globalThis.fetch;
    const transportErrorMessage = 'merchant transport failed after payment';
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000155',
              paymentAttemptId: '00000000-0000-0000-0000-000000000255',
              executionProvider: 'dexter',
              reasonCode: 'policy_allow',
              reason: 'Authorized for delegated execution.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(async (_input, init) => {
        const finalizationBody = JSON.parse(String(init?.body));

        expect(finalizationBody.result.executionStatus).toBe('inconclusive');
        expect(finalizationBody.result.settlementEvidenceClass).toBe(
          'inconclusive',
        );
        expect(finalizationBody.result.merchantOutcome).toBe('no_response');
        expect(finalizationBody.result.diagnostic).toMatchObject({
          code: 'merchant_transport_lost',
          message: transportErrorMessage,
        });
        expect(finalizationBody.result).not.toHaveProperty('merchantResponse');
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          dexter: {
            reason: 'error',
            detail: transportErrorMessage,
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'inconclusive',
            paidRequestId: '00000000-0000-0000-0000-000000000155',
            paymentAttemptId: '00000000-0000-0000-0000-000000000255',
            reasonCode: 'merchant_transport_lost',
            reason: 'Merchant response lost after payment dispatch.',
            evidence: {
              delegatedProvider: 'dexter',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
    const merchantFetch = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        const headers = new Headers(init?.headers);

        if (headers.get('x-payment')) {
          throw new TypeError(transportErrorMessage);
        }

        return new Response(
          JSON.stringify({
            accepts: [
              {
                scheme: 'exact',
                network: 'base',
                amount: '1000000',
                asset: baseMoney.asset,
                payTo: '0xmerchant',
                extra: {
                  name: 'USD Coin',
                  version: '2',
                },
              },
            ],
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    );

    globalThis.fetch = merchantFetch;

    try {
      const client = new AgentPayClient({
        controlPlaneBaseUrl: 'http://localhost:3001',
        auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
        ...baseContext,
        fetch: controlPlaneFetch,
      });
      const prepared = await prepareDexterReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'dexter',
          executor: createDexterExecutor({
            wallets: dexterWallets,
          }),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchPaidError);
      if (!(error instanceof FetchPaidError)) {
        throw error;
      }
      expect(error.kind).toBe('execution_inconclusive');
      expect(error.reason).toBe('Merchant response lost after payment dispatch.');
      expect(error.decision.reasonCode).toBe('merchant_transport_lost');
      expect(merchantFetch).toHaveBeenCalledTimes(2);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
      expect(
        new Headers(merchantFetch.mock.calls[1]?.[1]?.headers).get('x-payment'),
      ).toBeTruthy();
      expect(controlPlaneFetch.mock.calls[0]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-authorizations',
      );
      expect(controlPlaneFetch.mock.calls[1]?.[0]).toBe(
        'http://localhost:3001/api/sdk/payment-finalizations',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});