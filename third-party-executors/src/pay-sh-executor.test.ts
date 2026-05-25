import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreparedRequestExecutorInput } from '@402flow/sdk';
import type { x402PaymentResult } from '@x402/core/client';
import type { Network, PaymentPayload, PaymentRequired } from '@x402/core/types';

import {
  createPayShExecutor,
  type PayShExecutorOptions,
} from './pay-sh-executor.js';

const createPaymentPayloadMock = vi.fn();
const encodePaymentSignatureHeaderMock = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
const getPaymentRequiredResponseMock = vi.fn();
const processResponseMock = vi.fn();

const supportedNetwork: Network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const unsupportedNetwork: Network = 'eip155:1';

const supportedRequirement = {
  scheme: 'exact',
  network: supportedNetwork,
  amount: '1000',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd',
  },
} satisfies PaymentRequired['accepts'][number];

const paymentRequired = {
  x402Version: 2,
  resource: {
    url: 'https://merchant.example.com/paid',
    description: 'Premium Solana report',
    mimeType: 'application/json',
  },
  accepts: [supportedRequirement],
} satisfies PaymentRequired;

const paymentPayload = {
  x402Version: 2,
  accepted: supportedRequirement,
  payload: {
    transaction: 'mock-partially-signed-transaction',
  },
} satisfies PaymentPayload;

const preparedInput = {
  prepared: {
    kind: 'ready',
    protocol: 'x402',
    request: {
      url: 'https://merchant.example.com/paid',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    },
    challenge: {
      protocol: 'x402',
      headers: {
        'payment-required': 'mock-payment-required',
      },
    },
    hints: {
      notes: [],
      requestBodyFields: [],
      requestPathParams: [],
      requestQueryParams: [],
    },
    validationIssues: [],
    nextAction: 'execute',
  } satisfies PreparedRequestExecutorInput['prepared'],
  authorization: {
    outcome: 'authorized',
    paidRequestId: '00000000-0000-0000-0000-000000000156',
    paymentAttemptId: '00000000-0000-0000-0000-000000000256',
    reasonCode: 'policy_allow',
    reason: 'Authorized for delegated execution.',
  } satisfies PreparedRequestExecutorInput['authorization'],
  request: {
    executionProvider: 'pay_sh',
  } satisfies PreparedRequestExecutorInput['request'],
};

const x402HttpClient = {
  createPaymentPayload: createPaymentPayloadMock,
  encodePaymentSignatureHeader: encodePaymentSignatureHeaderMock,
  getPaymentRequiredResponse: getPaymentRequiredResponseMock,
  processResponse: processResponseMock,
} satisfies NonNullable<PayShExecutorOptions['x402HttpClient']>;

function createExecutor() {
  return createPayShExecutor({
    signer: {} as PayShExecutorOptions['signer'],
    fetch: fetchMock,
    x402HttpClient,
  });
}

function mockPaidRetry(merchantResponse: Response) {
  getPaymentRequiredResponseMock.mockReturnValueOnce(paymentRequired);
  createPaymentPayloadMock.mockResolvedValueOnce(paymentPayload);
  encodePaymentSignatureHeaderMock.mockReturnValueOnce({
    'payment-signature': 'mock-payment-signature',
  });
  fetchMock.mockResolvedValueOnce(merchantResponse);
}

describe('createPayShExecutor', () => {
  beforeEach(() => {
    createPaymentPayloadMock.mockReset();
    encodePaymentSignatureHeaderMock.mockReset();
    fetchMock.mockReset();
    getPaymentRequiredResponseMock.mockReset();
    processResponseMock.mockReset();
  });

  it('maps settle_failed to merchant_execution_failed', async () => {
    const merchantResponse = new Response('{"ok":false}', {
      status: 502,
      headers: {
        'content-type': 'application/json',
      },
    });

    mockPaidRetry(merchantResponse);
    processResponseMock.mockResolvedValueOnce({
      kind: 'settle_failed',
      response: merchantResponse,
      body: { ok: false },
      settleResponse: {
        success: false,
        transaction: 'mock-settlement-reference',
        network: supportedNetwork,
        payer: 'Buyer1111111111111111111111111111111111111',
        amount: '1000',
        errorMessage: 'merchant facilitator errored while settling payment',
      },
    } satisfies Extract<x402PaymentResult, { kind: 'settle_failed' }>);

    const executor = createExecutor();
    const result = await executor.execute(preparedInput);

    expect(createPaymentPayloadMock).toHaveBeenCalledWith(paymentRequired);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'payment-signature': 'mock-payment-signature',
        },
        body: '{"prompt":"hello"}',
      },
    );
    expect(result).toMatchObject({
      protocol: 'x402',
      executionStatus: 'failed',
      settlementEvidenceClass: 'inconclusive',
      merchantOutcome: 'failure_response',
      settlementReference: 'mock-settlement-reference',
      paymentReference: 'mock-settlement-reference',
      evidenceSource: 'merchant',
      signerSubmissionEvidence: {
        txHash: 'mock-settlement-reference',
        paymentReference: 'mock-settlement-reference',
        payer: 'Buyer1111111111111111111111111111111111111',
        amountMinor: '1000',
        network: supportedRequirement.network,
      },
      merchantResponse: {
        status: 502,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":false}',
      },
      diagnostic: {
        code: 'merchant_execution_failed',
        message: 'merchant facilitator errored while settling payment',
      },
      protocolArtifacts: {
        paySh: {
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: supportedRequirement.network,
            amount: '1000',
            asset: supportedRequirement.asset,
          },
          payloadKeys: ['transaction'],
          settleResponse: {
            transaction: 'mock-settlement-reference',
            errorMessage: 'merchant facilitator errored while settling payment',
          },
        },
      },
    });
  });

  it('maps payment_required to merchant_rejected', async () => {
    const merchantResponse = new Response('{"error":"payment still required"}', {
      status: 402,
      headers: {
        'content-type': 'application/json',
      },
    });
    const retryPaymentRequired = {
      ...paymentRequired,
      error: 'payment still required after retry',
    } satisfies PaymentRequired;

    mockPaidRetry(merchantResponse);
    processResponseMock.mockResolvedValueOnce({
      kind: 'payment_required',
      response: merchantResponse,
      paymentRequired: retryPaymentRequired,
    } satisfies Extract<x402PaymentResult, { kind: 'payment_required' }>);

    const executor = createExecutor();
    const result = await executor.execute(preparedInput);

    expect(result).toMatchObject({
      protocol: 'x402',
      executionStatus: 'failed',
      settlementEvidenceClass: 'none',
      merchantOutcome: 'failure_response',
      merchantResponse: {
        status: 402,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"error":"payment still required"}',
      },
      diagnostic: {
        code: 'merchant_rejected',
        message: 'payment still required after retry',
      },
      protocolArtifacts: {
        paySh: {
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: supportedRequirement.network,
            amount: '1000',
            asset: supportedRequirement.asset,
          },
          payloadKeys: ['transaction'],
          paymentRequired: {
            error: 'payment still required after retry',
          },
        },
      },
    });
  });

  it('maps passthrough to preflight_incompatible', async () => {
    const merchantResponse = new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    mockPaidRetry(merchantResponse);
    processResponseMock.mockResolvedValueOnce({
      kind: 'passthrough',
      response: merchantResponse,
      body: { ok: true },
    } satisfies Extract<x402PaymentResult, { kind: 'passthrough' }>);

    const executor = createExecutor();
    const result = await executor.execute(preparedInput);

    expect(result).toMatchObject({
      protocol: 'x402',
      executionStatus: 'preflight_failed',
      settlementEvidenceClass: 'none',
      merchantOutcome: 'success_response',
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":true}',
      },
      diagnostic: {
        code: 'preflight_incompatible',
        message:
          'Merchant completed the request without returning x402 settlement evidence.',
      },
      protocolArtifacts: {
        paySh: {
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: supportedRequirement.network,
            amount: '1000',
            asset: supportedRequirement.asset,
          },
          payloadKeys: ['transaction'],
        },
      },
    });
  });

  it('fails preflight when no supported exact Solana requirement is present', async () => {
    getPaymentRequiredResponseMock.mockReturnValueOnce({
      x402Version: 2,
      resource: {
        url: 'https://merchant.example.com/paid',
        description: 'Premium EVM report',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: unsupportedNetwork,
          amount: '1000',
          asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    } satisfies PaymentRequired);

    const executor = createExecutor();
    const result = await executor.execute(preparedInput);

    expect(createPaymentPayloadMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      protocol: 'x402',
      executionStatus: 'preflight_failed',
      settlementEvidenceClass: 'none',
      merchantOutcome: 'unknown',
      diagnostic: {
        code: 'preflight_incompatible',
        message:
          'pay.sh x402 executor requires an exact Solana payment candidate with a facilitator fee payer.',
      },
      protocolArtifacts: {
        paySh: {
          stage: 'preflight',
        },
      },
    });
  });
});