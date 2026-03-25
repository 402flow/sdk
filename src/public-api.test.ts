import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  createAgentPayClient,
  sdkPaymentDecisionResponseSchema,
  sdkReceiptSchema,
} from '@402flow/sdk';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const baseTarget = {
  merchant: 'synthetic-demo-merchant',
  paymentRail: 'synthetic-demo-rail',
};

describe('public SDK entrypoint', () => {
  it('exports receipt finality schemas through the public package import', () => {
    const receipt = sdkReceiptSchema.parse({
      receiptId: '00000000-0000-0000-0000-000000000030',
      paidRequestId: '00000000-0000-0000-0000-000000000130',
      paymentAttemptId: '00000000-0000-0000-0000-000000000230',
      organizationId: '00000000-0000-0000-0000-000000000001',
      agentId: '00000000-0000-0000-0000-000000000002',
      merchantId: '00000000-0000-0000-0000-000000000003',
      protocol: 'x402',
      money: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '0.010000',
        amountMinor: '10000',
        precision: 6,
        unit: 'minor',
      },
      authorizationOutcome: 'allowed',
      status: 'provisional',
      reconciliationStatus: 'required',
      canonicalSettlementKey: 'merchant-ref:public-parse',
      requestUrl: 'https://merchant.example.com/data',
      requestMethod: 'GET',
      createdAt: '2026-03-10T00:00:00.000Z',
    });

    const decision = sdkPaymentDecisionResponseSchema.parse({
      outcome: 'allow',
      paidRequestId: '00000000-0000-0000-0000-000000000130',
      paymentAttemptId: '00000000-0000-0000-0000-000000000230',
      reasonCode: 'settlement_proof_conflict',
      reason: 'Merchant response delivered while settlement attribution is under reconciliation.',
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":true}',
      },
      receipt,
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.receipt.status).toBe('provisional');
    expect(decision.merchantResponse.body).toBe('{"ok":true}');
  });

  it('supports a synthetic-style paid request through the public package import', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000130',
            paymentAttemptId: '00000000-0000-0000-0000-000000000230',
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
              receiptId: '00000000-0000-0000-0000-000000000030',
              paidRequestId: '00000000-0000-0000-0000-000000000130',
              paymentAttemptId: '00000000-0000-0000-0000-000000000230',
              organizationId: '00000000-0000-0000-0000-000000000001',
              agentId: '00000000-0000-0000-0000-000000000002',
              merchantId: '00000000-0000-0000-0000-000000000003',
              protocol: 'x402',
              money: {
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                amount: '0.010000',
                amountMinor: '10000',
                precision: 6,
                unit: 'minor',
              },
              authorizationOutcome: 'allowed',
              status: 'confirmed',
              reconciliationStatus: 'none',
              requestUrl: 'https://merchant.example.com/data',
              requestMethod: 'GET',
              createdAt: '2026-03-10T00:00:00.000Z',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = createAgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      baseContext,
      {
        target: baseTarget,
        challenge: {
          protocol: 'x402',
          money: {
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '0.010000',
            amountMinor: '10000',
            precision: 6,
            unit: 'minor',
          },
          raw: {
            syntheticExecutionMode: 'mock',
          },
        },
      },
    );

    expect(result.kind).toBe('success');
  });

  it('supports an x402 challenge path through the public package import', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000131',
            reasonCode: 'policy_review_required',
            reason: 'Policy review required.',
            policyReviewEventId: '00000000-0000-0000-0000-000000000031',
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
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/premium',
      { method: 'GET' },
      baseContext,
      {
        target: baseTarget,
        challenge: {
          protocol: 'x402',
          money: {
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '50.000000',
            amountMinor: '50000000',
            precision: 6,
            unit: 'minor',
          },
          raw: {},
        },
      },
    );

    expect(result.kind).toBe('denied');
    if (result.kind !== 'denied') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.policyReviewEventId).toBe('00000000-0000-0000-0000-000000000031');
  });
});