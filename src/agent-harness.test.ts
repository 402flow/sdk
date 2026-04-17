import { describe, expect, it, vi } from 'vitest';

import type { SdkPaymentDecisionResponse } from './contracts.js';

import { AgentHarness } from './agent-harness.js';
import { AgentPayClient } from './index.js';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const baseReceipt = {
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

function createPaymentRequiredResponse() {
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

function createAllowDecisionResponse(
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

function createDecisionResponse(decision: SdkPaymentDecisionResponse) {
  return new Response(JSON.stringify(decision), {
    status: 201,
    headers: {
      'content-type': 'application/json',
    },
  });
}

describe('AgentHarness', () => {
  it('stores ready preparations with bound execution data and consumes them after execution', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(createAllowDecisionResponse());
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-1',
      now: () => new Date('2026-03-10T00:00:00.000Z'),
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
      externalMetadata: {
        requestBodyFields: [
          {
            name: 'prompt',
            type: 'string',
            required: true,
          },
        ],
        requestQueryParams: [
          {
            name: 'style',
            type: 'string',
            required: true,
          },
        ],
      },
    });

    expect(prepared).toMatchObject({
      preparedId: 'prepared-1',
      state: 'active',
      kind: 'ready',
      protocol: 'x402',
      challengeDetails: {
        x402Version: 2,
        resource: {
          description: 'Generate a deterministic premium artifact.',
        },
      },
      nextAction: 'execute',
      validationIssues: [],
    });
    expect(
      (prepared.challengeDetails?.extensions?.bazaar as { info?: { output?: { type?: string } } })
        ?.info?.output?.type,
    ).toBe('json');

    const storedRecord = harness.getPreparedRecord('prepared-1');
    expect(storedRecord.executionBinding).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://merchant.example.com/v1/generate?style=neo',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"prompt":"hello"}',
        bodyHash:
          '8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4',
        challenge: {
          protocol: 'x402',
          headers: expect.objectContaining({
            'payment-required': expect.any(String),
          }),
        },
        merchantOrigin: 'https://merchant.example.com',
      }),
    );

    storedRecord.executionBinding.headers['x-mutated'] = 'nope';
    expect(harness.getPreparedRecord('prepared-1').executionBinding.headers).toEqual({
      'content-type': 'application/json',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-1',
      executionContext: {
        description: 'Synthetic deterministic harness run.',
      },
    });

    expect(result).toEqual({
      preparedId: 'prepared-1',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'success',
      status: 200,
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":true}',
      },
      receiptId: baseReceipt.receiptId,
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:3001/api/sdk/payment-decisions',
    );
    const decisionRequest = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}'),
    );
    expect(decisionRequest.request).toMatchObject({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      body: '{"prompt":"hello"}',
      bodyHash:
        '8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4',
    });
    expect(decisionRequest.challenge).toMatchObject({
      protocol: 'x402',
    });

    expect(harness.getExecutionResult('prepared-1')).toEqual({
      preparedId: 'prepared-1',
      state: 'consumed',
      executionResult: result,
    });

    const duplicateExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-1',
    });
    expect(duplicateExecute).toEqual({
      preparedId: 'prepared-1',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_consumed',
      message: 'Prepared request prepared-1 has already been consumed.',
    });
    expect(harness.getExecutionResult('prepared-1')).toEqual({
      preparedId: 'prepared-1',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('rejects passthrough preparations locally when execution is attempted', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-free',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/free',
      method: 'GET',
    });

    expect(prepared).toMatchObject({
      preparedId: 'prepared-free',
      kind: 'passthrough',
      nextAction: 'treat_as_passthrough',
      validationIssues: [],
    });

    const rejected = await harness.executePreparedRequest({
      preparedId: 'prepared-free',
    });
    expect(rejected).toEqual({
      preparedId: 'prepared-free',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_not_ready',
      message:
        'Prepared request prepared-free is not executable because it is passthrough.',
    });
    expect(harness.getExecutionResult('prepared-free')).toEqual({
      preparedId: 'prepared-free',
      state: 'active',
      executionResult: rejected,
    });
  });

  it('stores merchant response payloads so callers can assert on semantic completion', async () => {
    const holidayPayload = {
      country: 'DE',
      year: 2026,
      holidays: [
        {
          date: '2026-01-01',
          localName: 'Neujahrstag',
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createAllowDecisionResponse({
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(holidayPayload),
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-holidays',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/public-holidays?country=DE&year=2026',
      method: 'GET',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-holidays',
    });

    if (result.harnessDisposition !== 'executed') {
      throw new Error('Expected executed harness result.');
    }

    const merchantPayload = JSON.parse(result.merchantResponse.body) as {
      country: string;
      year: number;
      holidays: Array<{ date: string }>;
    };

    expect(merchantPayload.country).toBe('DE');
    expect(merchantPayload.year).toBe(2026);
    expect(merchantPayload.holidays[0]?.date).toBe('2026-01-01');
  });

  it('supersedes older active prepared requests for the same endpoint path', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(createAllowDecisionResponse());
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const preparedIds = ['prepared-old', 'prepared-new'];
    const harness = new AgentHarness({
      client,
      createPreparedId: () => preparedIds.shift() ?? 'unexpected-prepared-id',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/public-holidays?country=DE&year=2025',
      method: 'GET',
    });
    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/public-holidays?country=DE&year=2026',
      method: 'GET',
    });

    expect(harness.getPreparedRecord('prepared-old')).toMatchObject({
      preparedId: 'prepared-old',
      state: 'superseded',
      supersededByPreparedId: 'prepared-new',
    });

    const staleExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-old',
    });
    expect(staleExecute).toEqual({
      preparedId: 'prepared-old',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_superseded',
      message: 'Prepared request prepared-old was superseded by prepared-new.',
    });

    expect(harness.getExecutionResult('prepared-old')).toEqual({
      preparedId: 'prepared-old',
      state: 'superseded',
      supersededByPreparedId: 'prepared-new',
      executionResult: staleExecute,
    });

    const freshExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-new',
    });
    expect(freshExecute).toMatchObject({
      preparedId: 'prepared-new',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'success',
      status: 200,
    });
  });

  it('rejects execution for prepared requests that require revision', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse());
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-revise',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
      externalMetadata: {
        requestBodyFields: [
          {
            name: 'prompt',
            type: 'string',
            required: true,
          },
          {
            name: 'style',
            type: 'string',
            required: true,
          },
        ],
      },
    });

    expect(prepared.nextAction).toBe('revise_request');
    expect(prepared.validationIssues).toEqual([
      expect.objectContaining({
        location: 'body',
        field: 'style',
        code: 'missing_required_field',
        source: 'external_metadata',
        blocking: true,
      }),
    ]);

    const rejected = await harness.executePreparedRequest({
      preparedId: 'prepared-revise',
    });
    expect(rejected).toEqual({
      preparedId: 'prepared-revise',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_not_executable',
      message:
        'Prepared request prepared-revise requires revise_request before execution.',
    });
    expect(harness.getExecutionResult('prepared-revise')).toEqual({
      preparedId: 'prepared-revise',
      state: 'active',
      executionResult: rejected,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores denied outcomes with policy review metadata in the execution summary', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'deny',
          paidRequestId: baseReceipt.paidRequestId,
          reasonCode: 'policy_review_required',
          reason: 'Manual review is required before this paid request can run.',
          policyReviewEventId: '00000000-0000-0000-0000-000000000031',
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-denied',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-denied',
    });

    expect(result).toMatchObject({
      preparedId: 'prepared-denied',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'denied',
      status: 403,
      merchantResponse: {
        status: 403,
      },
      paidRequestId: baseReceipt.paidRequestId,
      reason: 'Manual review is required before this paid request can run.',
      policyReviewEventId: '00000000-0000-0000-0000-000000000031',
    });
    expect(harness.getExecutionResult('prepared-denied')).toEqual({
      preparedId: 'prepared-denied',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('stores execution_failed outcomes with the merchant failure reason', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'execution_failed',
          paidRequestId: baseReceipt.paidRequestId,
          paymentAttemptId: baseReceipt.paymentAttemptId,
          reasonCode: 'merchant_execution_failed',
          reason: 'The merchant failed after payment execution started.',
          merchantResponse: {
            status: 502,
            headers: {
              'content-type': 'application/json',
            },
            body: '{"error":"upstream failure"}',
          },
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-execution-failed',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-execution-failed',
    });

    expect(result).toMatchObject({
      preparedId: 'prepared-execution-failed',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'execution_failed',
      status: 502,
      merchantResponse: {
        status: 502,
        body: '{"error":"upstream failure"}',
      },
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
      reason: 'The merchant failed after payment execution started.',
    });
    expect(harness.getExecutionResult('prepared-execution-failed')).toEqual({
      preparedId: 'prepared-execution-failed',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('stores paid_fulfillment_failed outcomes with the durable receipt link', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'paid_fulfillment_failed',
          paidRequestId: baseReceipt.paidRequestId,
          paymentAttemptId: baseReceipt.paymentAttemptId,
          reasonCode: 'merchant_rejected',
          reason: 'Payment settled but the merchant rejected fulfillment.',
          merchantResponse: {
            status: 424,
            headers: {
              'content-type': 'application/json',
            },
            body: '{"error":"fulfillment failed"}',
          },
          settlementEvidenceClass: 'merchant_verifiable_success',
          fulfillmentStatus: 'failed',
          receipt: {
            ...baseReceipt,
            status: 'provisional',
          },
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-fulfillment-failed',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-fulfillment-failed',
    });

    expect(result).toMatchObject({
      preparedId: 'prepared-fulfillment-failed',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'paid_fulfillment_failed',
      status: 424,
      merchantResponse: {
        status: 424,
        body: '{"error":"fulfillment failed"}',
      },
      receiptId: baseReceipt.receiptId,
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
      reason: 'Payment settled but the merchant rejected fulfillment.',
    });
    expect(harness.getExecutionResult('prepared-fulfillment-failed')).toEqual({
      preparedId: 'prepared-fulfillment-failed',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('stores preflight_failed outcomes with the paid request identifiers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'preflight_failed',
          paidRequestId: baseReceipt.paidRequestId,
          paymentAttemptId: baseReceipt.paymentAttemptId,
          reasonCode: 'preflight_incompatible',
          reason: 'The prepared request could not be executed on the selected rail.',
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-preflight-failed',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-preflight-failed',
    });

    expect(result).toMatchObject({
      preparedId: 'prepared-preflight-failed',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'preflight_failed',
      status: 502,
      merchantResponse: {
        status: 502,
      },
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
      reason: 'The prepared request could not be executed on the selected rail.',
    });
    expect(harness.getExecutionResult('prepared-preflight-failed')).toEqual({
      preparedId: 'prepared-preflight-failed',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('stores execution_inconclusive outcomes with the payment attempt identifiers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'inconclusive',
          paidRequestId: baseReceipt.paidRequestId,
          paymentAttemptId: baseReceipt.paymentAttemptId,
          reasonCode: 'merchant_transport_lost',
          reason: 'The merchant transport was lost before a final paid outcome was confirmed.',
        }),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-inconclusive',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-inconclusive',
    });

    expect(result).toMatchObject({
      preparedId: 'prepared-inconclusive',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'execution_inconclusive',
      status: 202,
      merchantResponse: {
        status: 202,
      },
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
      reason:
        'The merchant transport was lost before a final paid outcome was confirmed.',
    });
    expect(harness.getExecutionResult('prepared-inconclusive')).toEqual({
      preparedId: 'prepared-inconclusive',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('rejects missing, unknown, and expired prepared ids without calling the SDK', async () => {
    const now = new Date('2026-03-10T00:00:00.000Z');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse());
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });
    const harness = new AgentHarness({
      client,
      createPreparedId: () => 'prepared-expiring',
      preparedTtlMs: 1_000,
      now: () => now,
    });

    expect(
      await harness.executePreparedRequest({
        preparedId: '',
      }),
    ).toEqual({
      preparedId: '',
      harnessDisposition: 'rejected',
      rejectionCode: 'missing_prepared_id',
      message: 'A preparedId is required.',
    });

    expect(
      await harness.executePreparedRequest({
        preparedId: 'prepared-unknown',
      }),
    ).toEqual({
      preparedId: 'prepared-unknown',
      harnessDisposition: 'rejected',
      rejectionCode: 'unknown_prepared_id',
      message: 'Prepared request prepared-unknown is unknown.',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    now.setTime(new Date('2026-03-10T00:00:02.000Z').getTime());

    const expired = await harness.executePreparedRequest({
      preparedId: 'prepared-expiring',
    });
    expect(expired).toEqual({
      preparedId: 'prepared-expiring',
      harnessDisposition: 'rejected',
      rejectionCode: 'expired_prepared_id',
      message: 'Prepared request prepared-expiring has expired.',
    });
    expect(harness.getPreparedRecord('prepared-expiring').state).toBe('expired');
    expect(harness.getExecutionResult('prepared-expiring')).toEqual({
      preparedId: 'prepared-expiring',
      state: 'expired',
      executionResult: expired,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});