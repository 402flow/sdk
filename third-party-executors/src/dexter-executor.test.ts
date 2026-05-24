import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreparedRequestExecutorInput } from '@402flow/sdk';

const { getPaymentReceiptMock, payAndFetchMock } = vi.hoisted(() => ({
  getPaymentReceiptMock: vi.fn(),
  payAndFetchMock: vi.fn(),
}));

vi.mock('@dexterai/x402/client', () => ({
  getPaymentReceipt: getPaymentReceiptMock,
  payAndFetch: payAndFetchMock,
}));

import { createDexterExecutor } from './dexter-executor.js';

const wallets = {
  evm: {
    address: '0x1111111111111111111111111111111111111111',
    signTypedData: async () => '0xdeadbeef',
  },
};

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
    executionProvider: 'dexter',
  } satisfies PreparedRequestExecutorInput['request'],
};

describe('createDexterExecutor', () => {
  beforeEach(() => {
    getPaymentReceiptMock.mockReset();
    payAndFetchMock.mockReset();
  });

  it('maps settlement_failed to merchant_execution_failed', async () => {
    payAndFetchMock.mockResolvedValueOnce({
      ok: false,
      reason: 'settlement_failed',
      detail: 'merchant facilitator errored while settling payment',
    });

    const executor = createDexterExecutor({ wallets });
    const result = await executor.execute(preparedInput);

    expect(payAndFetchMock).toHaveBeenCalledWith(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"prompt":"hello"}',
      },
      wallets,
      {},
    );
    expect(result).toMatchObject({
      protocol: 'x402',
      executionStatus: 'failed',
      settlementEvidenceClass: 'inconclusive',
      merchantOutcome: 'unknown',
      diagnostic: {
        code: 'merchant_execution_failed',
        message: 'merchant facilitator errored while settling payment',
      },
      protocolArtifacts: {
        dexter: {
          reason: 'settlement_failed',
          detail: 'merchant facilitator errored while settling payment',
        },
      },
    });
  });
});