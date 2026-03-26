import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  FetchPaidError,
  createAgentPayClient,
} from './index.js';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

const basePaymentRail = 'synthetic-demo-rail';

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

const baseReceipt = {
  receiptId: '00000000-0000-0000-0000-000000000030',
  paidRequestId: '00000000-0000-0000-0000-000000000130',
  paymentAttemptId: '00000000-0000-0000-0000-000000000230',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  merchantId: '00000000-0000-0000-0000-000000000003',
  protocol: 'x402' as const,
  money: baseChallenge.money,
  authorizationOutcome: 'allowed' as const,
  status: 'confirmed' as const,
  reconciliationStatus: 'none' as const,
  requestUrl: 'https://merchant.example.com/data',
  requestMethod: 'POST' as const,
  createdAt: '2026-03-10T00:00:00.000Z',
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
      { ...baseContext, paymentRail: basePaymentRail },
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
              ...baseReceipt,
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
      { ...baseContext, paymentRail: basePaymentRail, challenge: baseChallenge },
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
                  ...baseReceipt,
                  receiptId: '00000000-0000-0000-0000-000000000020',
                paidRequestId: '00000000-0000-0000-0000-000000000120',
                paymentAttemptId: '00000000-0000-0000-0000-000000000220',
                requestUrl: 'https://merchant.example.com/data',
                requestMethod: 'GET',
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

  it('throws policy review denials with the review event id', async () => {
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

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: {
          ...baseChallenge,
          money: {
            ...baseChallenge.money,
            amount: '50.000000',
            amountMinor: '50000000',
          },
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('denied');
    expect(error.policyReviewEventId).toBe('00000000-0000-0000-0000-000000000031');
    expect(error.reason).toBe('Policy review required.');
  });

  it('throws structured execution failures when the control plane returns non-ok JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000140',
            paymentAttemptId: '00000000-0000-0000-0000-000000000240',
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
            status: 402,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('execution_failed');
    expect(error.reason).toBe('Merchant rejected the paid request.');
    expect(error.decision.reasonCode).toBe('merchant_rejected');
  });

  it('returns delivered merchant responses with a provisional receipt on allow outcomes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000150',
            paymentAttemptId: '00000000-0000-0000-0000-000000000250',
            reasonCode: 'settlement_proof_conflict',
            reason: 'Merchant delivered the response while settlement attribution remains ambiguous.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true,"replay":"stable"}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000150',
              paymentAttemptId: '00000000-0000-0000-0000-000000000250',
              status: 'provisional',
              reconciliationStatus: 'required',
              canonicalSettlementKey: 'merchant-ref:ambiguous-150',
              settlementEvidenceClass: 'merchant_verifiable_success',
              fulfillmentStatus: 'succeeded',
            },
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
      'https://merchant.example.com/data',
      { method: 'GET' },
      {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: {
          ...baseChallenge,
          money: {
            ...baseChallenge.money,
            amount: '2.000000',
            amountMinor: '2000000',
          },
        },
      },
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.receipt.status).toBe('provisional');
    expect(result.receipt.reconciliationStatus).toBe('required');
    expect(result.receipt.canonicalSettlementKey).toBe(
      'merchant-ref:ambiguous-150',
    );
    await expect(result.response.text()).resolves.toBe(
      '{"ok":true,"replay":"stable"}',
    );
  });

  it('throws paid fulfillment failures with provisional receipts when payment likely succeeded', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'paid_fulfillment_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000151',
            paymentAttemptId: '00000000-0000-0000-0000-000000000251',
            reasonCode: 'merchant_rejected',
            reason: 'Merchant reported fulfillment failure after a paid path was observed.',
            merchantResponse: {
              status: 502,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"upstream unavailable"}',
            },
            settlementEvidenceClass: 'merchant_verifiable_success',
            fulfillmentStatus: 'failed',
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000151',
              paymentAttemptId: '00000000-0000-0000-0000-000000000251',
              status: 'provisional',
              reconciliationStatus: 'required',
              settlementEvidenceClass: 'merchant_verifiable_success',
              fulfillmentStatus: 'failed',
            },
            evidence: {
              merchantStatus: 502,
            },
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

    const error = await client
      .fetchPaid('https://merchant.example.com/data', { method: 'GET' }, {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('paid_fulfillment_failed');
    expect(error.receipt?.status).toBe('provisional');
    expect(error.receipt?.reconciliationStatus).toBe('required');
    expect(error.decision.merchantResponse.body).toBe(
      '{"error":"upstream unavailable"}',
    );
    await expect(error.response.text()).resolves.toBe(
      '{"error":"upstream unavailable"}',
    );
  });

  it('keeps receipt identity and merchant response bodies deterministic across replayed decisions', async () => {
    const replayDecision = {
      outcome: 'allow',
      paidRequestId: '00000000-0000-0000-0000-000000000152',
      paymentAttemptId: '00000000-0000-0000-0000-000000000252',
      reasonCode: 'settlement_proof_conflict',
      reason: 'Replaying durable merchant success with provisional receipt.',
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-replay-source': 'durable-attempt',
        },
        body: '{"result":"stable"}',
      },
      receipt: {
        ...baseReceipt,
        paidRequestId: '00000000-0000-0000-0000-000000000152',
        paymentAttemptId: '00000000-0000-0000-0000-000000000252',
        status: 'provisional',
        reconciliationStatus: 'required',
        canonicalSettlementKey: 'merchant-ref:replay-152',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(replayDecision), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(replayDecision), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      fetch: fetchMock,
    });

    const first = await client.fetchPaid(
      'https://merchant.example.com/replay',
      { method: 'GET' },
      { ...baseContext, paymentRail: basePaymentRail, challenge: baseChallenge },
    );
    const second = await client.fetchPaid(
      'https://merchant.example.com/replay',
      { method: 'GET' },
      { ...baseContext, paymentRail: basePaymentRail, challenge: baseChallenge },
    );

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') {
      throw new Error('Unexpected replay result kind.');
    }
    expect(first.receiptId).toBe(second.receiptId);
    expect(first.receipt.status).toBe('provisional');
    expect(second.receipt.status).toBe('provisional');
    await expect(first.response.text()).resolves.toBe('{"result":"stable"}');
    await expect(second.response.text()).resolves.toBe('{"result":"stable"}');
  });

  it('throws execution progress states as typed SDK errors', async () => {
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

    const executing = await client
      .fetchPaid('https://merchant.example.com/pending', { method: 'GET' }, {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);
    const inconclusive = await client
      .fetchPaid('https://merchant.example.com/inconclusive', { method: 'GET' }, {
        ...baseContext,
        paymentRail: basePaymentRail,
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(executing).toBeInstanceOf(FetchPaidError);
    if (!(executing instanceof FetchPaidError)) {
      throw executing;
    }
    expect(executing.kind).toBe('execution_pending');
    expect(executing.response.status).toBe(202);
    expect(executing.reason).toBe('Still executing.');

    expect(inconclusive).toBeInstanceOf(FetchPaidError);
    if (!(inconclusive instanceof FetchPaidError)) {
      throw inconclusive;
    }
    expect(inconclusive.kind).toBe('execution_inconclusive');
    expect(inconclusive.response.status).toBe(202);
    expect(inconclusive.reason).toBe('Merchant response lost.');
  });
});
