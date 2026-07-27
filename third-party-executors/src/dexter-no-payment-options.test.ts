import { expect, it, vi } from 'vitest';

import type { PreparedRequestExecutorInput } from '@402flow/sdk';

const { payAndFetchMock } = vi.hoisted(() => ({
  payAndFetchMock: vi.fn(),
}));

vi.mock('@dexterai/x402/client', () => ({
  getPaymentReceipt: vi.fn(),
  payAndFetch: payAndFetchMock,
}));

import { createDexterExecutor } from './dexter-executor.js';

it('maps no_payment_options to a typed preflight failure', async () => {
  payAndFetchMock.mockResolvedValueOnce({
    ok: false,
    reason: 'no_payment_options',
    detail: 'no generically payable scheme offered (got: )',
  });

  const input = {
    prepared: {
      kind: 'ready',
      protocol: 'x402',
      request: {
        url: 'https://merchant.example.com/paid',
        method: 'POST',
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
    },
    authorization: {
      outcome: 'authorized',
      paidRequestId: '00000000-0000-0000-0000-000000000157',
      paymentAttemptId: '00000000-0000-0000-0000-000000000257',
      reasonCode: 'policy_allow',
      reason: 'Authorized for delegated execution.',
    },
    request: {
      executionProvider: 'dexter',
    },
  } satisfies PreparedRequestExecutorInput;

  const executor = createDexterExecutor({
    wallets: {
      evm: {
        address: '0x1111111111111111111111111111111111111111',
        signTypedData: async () => '0xdeadbeef',
      },
    },
  });
  const result = await executor.execute(input);

  expect(result).toMatchObject({
    protocol: 'x402',
    executionStatus: 'preflight_failed',
    settlementEvidenceClass: 'none',
    merchantOutcome: 'unknown',
    diagnostic: {
      code: 'preflight_incompatible',
      message: 'no generically payable scheme offered (got: )',
    },
    protocolArtifacts: {
      dexter: {
        reason: 'no_payment_options',
        detail: 'no generically payable scheme offered (got: )',
      },
    },
  });
});
