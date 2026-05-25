import { describe, expect, it, vi } from 'vitest';

import { AgentPayClient, FetchPaidError } from '@402flow/sdk';
import {
  x402HTTPClient,
  type x402Client,
} from '@x402/core/client';
import { encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';

import {
  createPayShExecutor,
  type PayShExecutorOptions,
} from '../src/pay-sh-executor.js';

const testPayShSigner = {} as PayShExecutorOptions['signer'];

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const baseMoney = {
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '0.001000',
  amountMinor: '1000',
  precision: 6,
  unit: 'minor' as const,
};

const baseReceipt = {
  receiptId: '00000000-0000-0000-0000-000000000031',
  paidRequestId: '00000000-0000-0000-0000-000000000131',
  paymentAttemptId: '00000000-0000-0000-0000-000000000231',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  merchantId: '00000000-0000-0000-0000-000000000003',
  protocol: 'x402' as const,
  money: baseMoney,
  authorizationOutcome: 'allowed' as const,
  status: 'confirmed' as const,
  reconciliationStatus: 'none' as const,
  requestUrl: 'https://merchant.example.com/solana-report',
  requestMethod: 'POST' as const,
  createdAt: '2026-03-10T00:00:00.000Z',
};

function createPayShChallengeHeaders() {
  return {
    'payment-required': Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: {
          url: 'https://merchant.example.com/solana-report',
          description: 'Premium Solana report',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            amount: '1000',
            asset: baseMoney.asset,
            payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
            maxTimeoutSeconds: 60,
            extra: {
              feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd',
              memo: 'pi_3abc123def456',
              precision: 6,
              name: 'USD Coin',
            },
          },
        ],
      }),
      'utf8',
    ).toString('base64'),
  };
}

async function preparePayShReadyRequest(client: AgentPayClient) {
  const prepared = await client.preparePaidRequest(
    'https://merchant.example.com/solana-report',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"topic":"solana receipts"}',
    },
    {
      challenge: {
        protocol: 'x402',
        headers: createPayShChallengeHeaders(),
      },
    },
  );

  if (prepared.kind !== 'ready') {
    throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
  }

  return prepared;
}

function createStaticX402HttpClient() {
  return new x402HTTPClient({
    async createPaymentPayload(paymentRequired: PaymentRequired) {
      return {
        x402Version: paymentRequired.x402Version,
        accepted: paymentRequired.accepts[0]!,
        payload: {
          transaction: 'mock-partially-signed-transaction',
        },
      };
    },
  } as unknown as x402Client);
}

describe('pay.sh x402 executor integration proof', () => {
  it('authorizes, retries with payment-signature, and finalizes a Solana x402 exact payment', async () => {
    const originalFetch = globalThis.fetch;
    const settledTransaction = '3g4Qv2F2QwXh9Y8V7K4B2rT9m7R8s6p5N4q3w2x1zabc';
    const settledPayer = 'Buyer1111111111111111111111111111111111111';
    const x402HttpClient = createStaticX402HttpClient();
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000162',
              paymentAttemptId: '00000000-0000-0000-0000-000000000262',
              executionProvider: 'pay_sh',
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
        expect(finalizationBody.result.settlementReference).toBe(settledTransaction);
        expect(finalizationBody.result.paymentReference).toBe(settledTransaction);
        expect(finalizationBody.result.evidenceSource).toBe('merchant');
        expect(finalizationBody.result.signerSubmissionEvidence).toMatchObject({
          txHash: settledTransaction,
          paymentReference: settledTransaction,
          payer: settledPayer,
          amountMinor: '1000',
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        });
        expect(finalizationBody.result.merchantResponse).toMatchObject({
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
          body: '{"ok":true}',
        });
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          paySh: {
            x402Version: 2,
            accepted: {
              scheme: 'exact',
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              amount: '1000',
              asset: baseMoney.asset,
            },
            payloadKeys: ['transaction'],
            settleResponse: {
              success: true,
              transaction: settledTransaction,
              payer: settledPayer,
            },
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000162',
            paymentAttemptId: '00000000-0000-0000-0000-000000000262',
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
              paidRequestId: '00000000-0000-0000-0000-000000000162',
              paymentAttemptId: '00000000-0000-0000-0000-000000000262',
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

        if (headers.get('payment-signature')) {
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'payment-response': encodePaymentResponseHeader({
                success: true,
                transaction: settledTransaction,
                network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
                payer: settledPayer,
                amount: '1000',
              }),
            },
          });
        }

        return new Response(
          JSON.stringify({
            error: 'payment required',
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
              ...createPayShChallengeHeaders(),
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
      const prepared = await preparePayShReadyRequest(client);

      const result = await client.executePreparedRequest(prepared, {
        executionProvider: 'pay_sh',
        executor: createPayShExecutor({
          signer: testPayShSigner,
          fetch: merchantFetch,
          x402HttpClient,
        }),
      });

      expect(result.kind).toBe('success');
      expect(merchantFetch).toHaveBeenCalledTimes(1);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
      expect(
        new Headers(merchantFetch.mock.calls[0]?.[1]?.headers).get('payment-signature'),
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

  it('finalizes pay.sh settlement failures as merchant execution failures', async () => {
    const originalFetch = globalThis.fetch;
    const settledTransaction = '3g4Qv2F2QwXh9Y8V7K4B2rT9m7R8s6p5N4q3w2x1zaef';
    const settledPayer = 'Buyer1111111111111111111111111111111111111';
    const x402HttpClient = createStaticX402HttpClient();
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000164',
              paymentAttemptId: '00000000-0000-0000-0000-000000000264',
              executionProvider: 'pay_sh',
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
        expect(finalizationBody.result.settlementEvidenceClass).toBe('inconclusive');
        expect(finalizationBody.result.merchantOutcome).toBe('failure_response');
        expect(finalizationBody.result.settlementReference).toBe(settledTransaction);
        expect(finalizationBody.result.paymentReference).toBe(settledTransaction);
        expect(finalizationBody.result.evidenceSource).toBe('merchant');
        expect(finalizationBody.result.signerSubmissionEvidence).toMatchObject({
          txHash: settledTransaction,
          paymentReference: settledTransaction,
          payer: settledPayer,
          amountMinor: '1000',
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        });
        expect(finalizationBody.result.diagnostic).toMatchObject({
          code: 'merchant_execution_failed',
          message: 'facilitator could not settle transaction',
        });
        expect(finalizationBody.result.merchantResponse).toMatchObject({
          status: 500,
          headers: {
            'content-type': 'application/json',
          },
          body: '{"error":"settlement failed"}',
        });
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          paySh: {
            x402Version: 2,
            accepted: {
              scheme: 'exact',
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              amount: '1000',
              asset: baseMoney.asset,
            },
            payloadKeys: ['transaction'],
            settleResponse: {
              success: false,
              transaction: settledTransaction,
              payer: settledPayer,
              errorReason: 'settlement_failed',
              errorMessage: 'facilitator could not settle transaction',
            },
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000164',
            paymentAttemptId: '00000000-0000-0000-0000-000000000264',
            reasonCode: 'merchant_execution_failed',
            reason: 'Merchant returned 500 during paid execution.',
            merchantResponse: {
              status: 500,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"settlement failed"}',
            },
            evidence: {
              merchantStatus: 500,
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

        expect(headers.get('payment-signature')).toBeTruthy();

        return new Response('{"error":"settlement failed"}', {
          status: 500,
          headers: {
            'content-type': 'application/json',
            'payment-response': encodePaymentResponseHeader({
              success: false,
              transaction: settledTransaction,
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              payer: settledPayer,
              amount: '1000',
              errorReason: 'settlement_failed',
              errorMessage: 'facilitator could not settle transaction',
            }),
          },
        });
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
      const prepared = await preparePayShReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'pay_sh',
          executor: createPayShExecutor({
            signer: testPayShSigner,
            fetch: merchantFetch,
            x402HttpClient,
          }),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchPaidError);
      if (!(error instanceof FetchPaidError)) {
        throw error;
      }
      expect(error.kind).toBe('execution_failed');
      expect(error.reason).toBe('Merchant returned 500 during paid execution.');
      expect(error.decision.reasonCode).toBe('merchant_execution_failed');
      expect(merchantFetch).toHaveBeenCalledTimes(1);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
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

  it('finalizes post-payment pay.sh merchant rejections separately from settlement failures', async () => {
    const originalFetch = globalThis.fetch;
    const x402HttpClient = createStaticX402HttpClient();
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000165',
              paymentAttemptId: '00000000-0000-0000-0000-000000000265',
              executionProvider: 'pay_sh',
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
        expect(finalizationBody.result.merchantResponse).toMatchObject({
          status: 402,
          headers: {
            'content-type': 'application/json',
          },
          body: '{"error":"payment required"}',
        });
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          paySh: {
            x402Version: 2,
            accepted: {
              scheme: 'exact',
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              amount: '1000',
              asset: baseMoney.asset,
            },
            payloadKeys: ['transaction'],
            paymentRequired: {
              x402Version: 2,
            },
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000165',
            paymentAttemptId: '00000000-0000-0000-0000-000000000265',
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

        expect(headers.get('payment-signature')).toBeTruthy();

        return new Response('{"error":"payment required"}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            ...createPayShChallengeHeaders(),
          },
        });
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
      const prepared = await preparePayShReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'pay_sh',
          executor: createPayShExecutor({
            signer: testPayShSigner,
            fetch: merchantFetch,
            x402HttpClient,
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
      expect(merchantFetch).toHaveBeenCalledTimes(1);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
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

  it('finalizes pay.sh post-payment transport loss as an inconclusive outcome', async () => {
    const originalFetch = globalThis.fetch;
    const transportErrorMessage = 'merchant transport failed after payment';
    const x402HttpClient = createStaticX402HttpClient();
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000166',
              paymentAttemptId: '00000000-0000-0000-0000-000000000266',
              executionProvider: 'pay_sh',
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
        expect(finalizationBody.result.settlementEvidenceClass).toBe('none');
        expect(finalizationBody.result.merchantOutcome).toBe('no_response');
        expect(finalizationBody.result.diagnostic).toMatchObject({
          code: 'merchant_transport_lost',
          message: transportErrorMessage,
        });
        expect(finalizationBody.result).not.toHaveProperty('merchantResponse');
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          paySh: {
            x402Version: 2,
            accepted: {
              scheme: 'exact',
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              amount: '1000',
              asset: baseMoney.asset,
            },
            payloadKeys: ['transaction'],
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'inconclusive',
            paidRequestId: '00000000-0000-0000-0000-000000000166',
            paymentAttemptId: '00000000-0000-0000-0000-000000000266',
            reasonCode: 'merchant_transport_lost',
            reason: 'Merchant response lost after payment dispatch.',
            evidence: {
              delegatedProvider: 'pay_sh',
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

        expect(headers.get('payment-signature')).toBeTruthy();
        throw new TypeError(transportErrorMessage);
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
      const prepared = await preparePayShReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'pay_sh',
          executor: createPayShExecutor({
            signer: testPayShSigner,
            fetch: merchantFetch,
            x402HttpClient,
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
      expect(merchantFetch).toHaveBeenCalledTimes(1);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
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

  it('finalizes pay.sh 2xx responses without settlement evidence as preflight failures', async () => {
    const originalFetch = globalThis.fetch;
    const x402HttpClient = createStaticX402HttpClient();
    const controlPlaneFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000167',
              paymentAttemptId: '00000000-0000-0000-0000-000000000267',
              executionProvider: 'pay_sh',
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

        expect(finalizationBody.result.executionStatus).toBe('preflight_failed');
        expect(finalizationBody.result.settlementEvidenceClass).toBe('none');
        expect(finalizationBody.result.merchantOutcome).toBe('success_response');
        expect(finalizationBody.result.merchantResponse).toMatchObject({
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
          body: '{"ok":true}',
        });
        expect(finalizationBody.result.diagnostic).toMatchObject({
          code: 'preflight_incompatible',
          message:
            'Merchant completed the request without returning x402 settlement evidence.',
        });
        expect(finalizationBody.result.protocolArtifacts).toMatchObject({
          paySh: {
            x402Version: 2,
            accepted: {
              scheme: 'exact',
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              amount: '1000',
              asset: baseMoney.asset,
            },
            payloadKeys: ['transaction'],
          },
        });

        return new Response(
          JSON.stringify({
            outcome: 'preflight_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000167',
            paymentAttemptId: '00000000-0000-0000-0000-000000000267',
            reasonCode: 'preflight_incompatible',
            reason: 'Merchant completed the request without settlement evidence.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true}',
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

        expect(headers.get('payment-signature')).toBeTruthy();

        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
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
      const prepared = await preparePayShReadyRequest(client);

      const error = await client
        .executePreparedRequest(prepared, {
          executionProvider: 'pay_sh',
          executor: createPayShExecutor({
            signer: testPayShSigner,
            fetch: merchantFetch,
            x402HttpClient,
          }),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchPaidError);
      if (!(error instanceof FetchPaidError)) {
        throw error;
      }
      expect(error.kind).toBe('preflight_failed');
      expect(error.reason).toBe(
        'Merchant completed the request without settlement evidence.',
      );
      expect(error.decision.reasonCode).toBe('preflight_incompatible');
      expect(error.response.status).toBe(502);
      expect(merchantFetch).toHaveBeenCalledTimes(1);
      expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
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

  it('surfaces delegated authorization denials before invoking the pay.sh executor', async () => {
    const controlPlaneFetch = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000163',
            reasonCode: 'policy_review_required',
            reason: 'Policy review required before delegated execution.',
            policyReviewEventId: '00000000-0000-0000-0000-000000000033',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: controlPlaneFetch,
    });
    const prepared = await preparePayShReadyRequest(client);
    const executor = {
      provider: 'pay_sh',
      execute: vi.fn(async () => ({
        protocol: 'x402' as const,
        executionStatus: 'succeeded' as const,
        settlementEvidenceClass: 'merchant_verifiable_success' as const,
        merchantOutcome: 'success_response' as const,
      })),
    };

    const error = await client
      .executePreparedRequest(prepared, {
        executionProvider: 'pay_sh',
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
      '00000000-0000-0000-0000-000000000033',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
  });
});