import { vi } from 'vitest';

import type { AgentHarnessClient } from '../src/agent-harness.js';
import type {
  SdkPaymentDecisionResponse,
  SdkPreparedPaidRequest,
  SdkPreparedPaidRequestPassthrough,
  SdkPreparedPaidRequestReady,
  SdkPreparedRequestHints,
} from '../src/contracts.js';
import type { SuccessPaidResponse } from '../src/index.js';

export const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

export const baseReceipt = {
  receiptId: '00000000-0000-0000-0000-000000000030',
  paidRequestId: '00000000-0000-0000-0000-000000000130',
  paymentAttemptId: '00000000-0000-0000-0000-000000000230',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  merchantId: '00000000-0000-0000-0000-000000000003',
  protocol: 'x402' as const,
  money: {
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '0.010000',
    amountMinor: '10000',
    precision: 6,
    unit: 'minor' as const,
  },
  authorizationOutcome: 'allowed' as const,
  status: 'confirmed' as const,
  reconciliationStatus: 'none' as const,
  requestUrl: 'https://merchant.example.com/v1/generate?style=neo',
  requestMethod: 'POST' as const,
  createdAt: '2026-03-10T00:00:00.000Z',
};

export const emptyHints: SdkPreparedRequestHints = {
  requestBodyFields: [],
  requestQueryParams: [],
  requestPathParams: [],
  notes: [],
};

export function createPaymentRequiredResponse() {
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: 'https://merchant.example.com/v1/generate',
      description: 'Generate a deterministic premium artifact.',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0xmerchant',
        extra: {
          precision: 6,
        },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: 'http',
            method: 'POST',
            bodyType: 'json',
            body: {
              prompt: 'hello',
            },
          },
          output: {
            type: 'json',
            example: {
              ok: true,
            },
          },
        },
      },
    },
  };
  const paymentRequiredHeader = Buffer.from(
    JSON.stringify(paymentRequired),
    'utf8',
  ).toString('base64');

  return new Response('{}', {
    status: 402,
    headers: {
      'payment-required': paymentRequiredHeader,
    },
  });
}

export function createAllowDecisionResponse(
  merchantResponse = {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: '{"ok":true}',
  },
) {
  return new Response(
    JSON.stringify({
      outcome: 'allow',
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
      reasonCode: 'policy_allow',
      reason: 'Allowed.',
      merchantResponse,
      receipt: baseReceipt,
    }),
    {
      status: 201,
      headers: {
        'content-type': 'application/json',
      },
    },
  );
}

export function createDecisionResponse(decision: SdkPaymentDecisionResponse) {
  return new Response(JSON.stringify(decision), {
    status: 201,
    headers: {
      'content-type': 'application/json',
    },
  });
}

export function createReadyPrepared(
  overrides: Partial<SdkPreparedPaidRequestReady> = {},
): SdkPreparedPaidRequestReady {
  return {
    kind: 'ready',
    protocol: 'x402',
    request: overrides.request ?? {
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
      bodyHash:
        '8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4',
    },
    challenge: overrides.challenge ?? {
      protocol: 'x402',
      headers: {
        'payment-required': 'payment-required-header',
      },
    },
    ...(overrides.challengeDetails !== undefined
      ? { challengeDetails: overrides.challengeDetails }
      : {}),
    ...(overrides.paymentRequirement !== undefined
      ? { paymentRequirement: overrides.paymentRequirement }
      : {}),
    hints: overrides.hints ?? emptyHints,
    ...(overrides.probe !== undefined ? { probe: overrides.probe } : {}),
    validationIssues: overrides.validationIssues ?? [],
    nextAction: overrides.nextAction ?? 'execute',
  };
}

export function createPassthroughPrepared(
  overrides: Partial<SdkPreparedPaidRequestPassthrough> = {},
): SdkPreparedPaidRequestPassthrough {
  return {
    kind: 'passthrough',
    protocol: 'none',
    request: overrides.request ?? {
      url: 'https://merchant.example.com/free',
      method: 'GET',
      headers: {},
    },
    hints: overrides.hints ?? emptyHints,
    ...(overrides.probe !== undefined ? { probe: overrides.probe } : {}),
    validationIssues: overrides.validationIssues ?? [],
    nextAction: overrides.nextAction ?? 'treat_as_passthrough',
  };
}

export function createSuccessPaidResponse(
  merchantResponse = {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: '{"ok":true}',
  },
): SuccessPaidResponse {
  return {
    kind: 'success',
    protocol: 'x402',
    response: new Response(merchantResponse.body, {
      status: merchantResponse.status,
      headers: merchantResponse.headers,
    }),
    paidRequestId: baseReceipt.paidRequestId,
    paymentAttemptId: baseReceipt.paymentAttemptId,
    receiptId: baseReceipt.receiptId,
    receipt: baseReceipt,
  };
}

export function createStaticClient(
  prepared: SdkPreparedPaidRequest | SdkPreparedPaidRequest[],
  executePreparedRequest: AgentHarnessClient['executePreparedRequest'] = vi.fn(
    () => Promise.reject(new Error('Unexpected executePreparedRequest call.')),
  ),
): AgentHarnessClient {
  const preparedQueue = Array.isArray(prepared) ? [...prepared] : [prepared];

  return {
    preparePaidRequest: vi.fn(() => {
      const nextPrepared = preparedQueue.shift();

      if (!nextPrepared) {
        throw new Error('No prepared response configured.');
      }

      return Promise.resolve(nextPrepared);
    }),
    executePreparedRequest,
  };
}