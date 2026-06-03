import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PreparedRequestExecutor,
  PreparedRequestExecutorInput,
  SdkDelegatedExecutionResult,
} from '@402flow/sdk';

import type { PayShExecutorOptions } from './pay-sh-executor.js';

const { createPayShExecutorMock, dexterModuleLoaded, payShModuleLoaded } = vi.hoisted(
  () => ({
    createPayShExecutorMock: vi.fn(),
    dexterModuleLoaded: vi.fn(),
    payShModuleLoaded: vi.fn(),
  }),
);

vi.mock('./dexter-executor.js', () => {
  dexterModuleLoaded();

  return {
    createDexterExecutor: vi.fn(),
  };
});

vi.mock('./pay-sh-executor.js', () => {
  payShModuleLoaded();

  return {
    createPayShExecutor: createPayShExecutorMock,
  };
});

import { createPayShExecutor } from './index.js';

const preparedInput = {
  prepared: {
    kind: 'ready',
    protocol: 'x402',
    request: {
      url: 'https://merchant.example.com/paid',
      method: 'POST',
      headers: {},
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
    paidRequestId: '00000000-0000-0000-0000-000000000156',
    paymentAttemptId: '00000000-0000-0000-0000-000000000256',
    reasonCode: 'policy_allow',
    reason: 'Authorized for delegated execution.',
  },
  request: {
    executionProvider: 'pay_sh',
  },
} satisfies PreparedRequestExecutorInput;

describe('package root entrypoint', () => {
  beforeEach(() => {
    createPayShExecutorMock.mockReset();
    dexterModuleLoaded.mockReset();
    payShModuleLoaded.mockReset();
  });

  it('executes pay.sh without importing the Dexter module', async () => {
    const delegatedResult: SdkDelegatedExecutionResult = {
      protocol: 'x402',
      executionStatus: 'inconclusive',
      settlementEvidenceClass: 'inconclusive',
      merchantOutcome: 'no_response',
      diagnostic: {
        code: 'merchant_transport_lost',
      },
    };
    const loadedExecute = vi.fn(async () => delegatedResult);
    const loadedExecutor: PreparedRequestExecutor = {
      provider: 'pay_sh',
      execute: loadedExecute,
    };
    const options = {
      signer: {} as PayShExecutorOptions['signer'],
    } satisfies PayShExecutorOptions;

    createPayShExecutorMock.mockReturnValueOnce(loadedExecutor);

    const executor = createPayShExecutor(options);

    expect(payShModuleLoaded).not.toHaveBeenCalled();
    expect(dexterModuleLoaded).not.toHaveBeenCalled();

    const result = await executor.execute(preparedInput);

    expect(payShModuleLoaded).toHaveBeenCalledTimes(1);
    expect(dexterModuleLoaded).not.toHaveBeenCalled();
    expect(createPayShExecutorMock).toHaveBeenCalledWith(options);
    expect(loadedExecute).toHaveBeenCalledWith(preparedInput);
    expect(result).toEqual(delegatedResult);
  });
});