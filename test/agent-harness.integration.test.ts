import { describe, expect, it, vi } from 'vitest';

import { AgentHarness } from '../src/agent-harness.js';
import { AgentPayClient } from '../src/index.js';
import {
  baseContext,
  baseReceipt,
  createAllowDecisionResponse,
  createDecisionResponse,
  createPaymentRequiredResponse,
} from './agent-harness.test-fixtures.js';

describe('AgentHarness integration flows', () => {
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

  it('stores denied outcomes with policy review metadata in the execution summary', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPaymentRequiredResponse())
      .mockResolvedValueOnce(
        createDecisionResponse({
          outcome: 'deny',
          paidRequestId: baseReceipt.paidRequestId,
          reasonCode: 'policy_review_required',
          reason: 'Blocked by policy. Review event created for operator follow-up.',
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
      reason: 'Blocked by policy. Review event created for operator follow-up.',
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
});