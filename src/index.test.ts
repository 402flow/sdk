import { describe, expect, it, vi } from 'vitest';

import { AgentPayClient, createAgentPayClient } from './index.js';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const baseTarget = {
  merchant: 'synthetic-demo-merchant',
  paymentRail: 'synthetic-demo-rail',
};

const baseChallenge = {
  protocol: 'x402' as const,
  money: {
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '1.000000',
    amountMinor: '1000000',
    precision: 6,
    unit: 'minor' as const,
  },
  raw: {},
};

describe('AgentPayClient', () => {
  it('passes through a normal fetch when the merchant response is not payable', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      baseContext,
      { target: baseTarget },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('passthrough');
    expect(result.protocol).toBe('none');
  });

  it('returns a discriminated success result and hashes the replayable request body', async () => {
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
              money: baseChallenge.money,
              authorizationOutcome: 'allowed',
              requestUrl: 'https://merchant.example.com/data',
              requestMethod: 'POST',
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
      headers: {
        'x-sdk-header': 'sdk-value',
      },
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"hello":"world"}',
      },
      baseContext,
      {
        target: baseTarget,
        challenge: baseChallenge,
      },
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }

    const request = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body));
    expect(payload.request.bodyHash).toBe(
      '93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588',
    );
    expect(result.receiptId).toBe('00000000-0000-0000-0000-000000000030');
  });

  it('exchanges a bootstrap key for a runtime token and reuses it for subsequent calls', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              token: 'runtime-token',
              expiresAt: '2099-03-14T20:15:00.000Z',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              receipt: {
                receiptId: '00000000-0000-0000-0000-000000000020',
                paidRequestId: '00000000-0000-0000-0000-000000000120',
                paymentAttemptId: '00000000-0000-0000-0000-000000000220',
                organizationId: '00000000-0000-0000-0000-000000000001',
                agentId: '00000000-0000-0000-0000-000000000002',
                merchantId: '00000000-0000-0000-0000-000000000003',
                protocol: 'x402',
                money: baseChallenge.money,
                authorizationOutcome: 'allowed',
                requestUrl: 'https://merchant.example.com/data',
                requestMethod: 'GET',
                createdAt: '2026-03-10T00:00:00.000Z',
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'bootstrapKey', bootstrapKey: 'bootstrap-key' },
      fetch: fetchMock,
    });

    await client.lookupReceipt('00000000-0000-0000-0000-000000000020');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer bootstrap-key',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer runtime-token',
    });
  });

  it('surfaces policy review denials as denied responses with the review event id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000130',
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
          ...baseChallenge,
          money: {
            ...baseChallenge.money,
            amount: '50.000000',
            amountMinor: '50000000',
          },
        },
      },
    );

    expect(result.kind).toBe('denied');
    if (result.kind !== 'denied') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.policyReviewEventId).toBe('00000000-0000-0000-0000-000000000031');
    expect(result.reason).toBe('Policy review required.');
  });

  it('parses structured execution failures even when the control plane returns 409', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000140',
            paymentAttemptId: '00000000-0000-0000-0000-000000000240',
            reasonCode: 'settlement_proof_conflict',
            reason:
              'Settlement proof is already linked to a different payment attempt.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true}',
            },
            evidence: {
              conflictType: 'receipt_settlement_proof_collision',
            },
          }),
          {
            status: 409,
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
        challenge: baseChallenge,
      },
    );

    expect(result.kind).toBe('execution_failed');
    if (result.kind !== 'execution_failed') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.reason).toBe(
      'Settlement proof is already linked to a different payment attempt.',
    );
    expect(result.decision.reasonCode).toBe('settlement_proof_conflict');
  });

  it('maps execution progress states to non-terminal SDK results', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'executing',
              paidRequestId: '00000000-0000-0000-0000-000000000130',
              paymentAttemptId: '00000000-0000-0000-0000-000000000230',
              reasonCode: 'payment_execution_in_progress',
              reason: 'Still executing.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'inconclusive',
              paidRequestId: '00000000-0000-0000-0000-000000000131',
              paymentAttemptId: '00000000-0000-0000-0000-000000000231',
              reasonCode: 'merchant_transport_lost',
              reason: 'Merchant response lost.',
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

    const executing = await client.fetchPaid(
      'https://merchant.example.com/pending',
      { method: 'GET' },
      baseContext,
      { target: baseTarget, challenge: baseChallenge },
    );
    const inconclusive = await client.fetchPaid(
      'https://merchant.example.com/inconclusive',
      { method: 'GET' },
      baseContext,
      { target: baseTarget, challenge: baseChallenge },
    );

    expect(executing.kind).toBe('execution_pending');
    if (executing.kind !== 'execution_pending') {
      throw new Error(`Unexpected result kind: ${executing.kind}`);
    }
    expect(executing.response.status).toBe(202);
    expect(executing.reason).toBe('Still executing.');
    expect(inconclusive.kind).toBe('execution_inconclusive');
    if (inconclusive.kind !== 'execution_inconclusive') {
      throw new Error(`Unexpected result kind: ${inconclusive.kind}`);
    }
    expect(inconclusive.response.status).toBe(202);
    expect(inconclusive.reason).toBe('Merchant response lost.');
  });
});
