import { describe, expect, it, vi } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

import {
  AgentPayClient,
  FetchPaidError,
  createAgentPayClient,
  sdkClientVersion,
  sdkClientVersionHeaderName,
  sdkPaymentDecisionResponseSchema,
  sdkReceiptSchema,
} from '@402flow/sdk';

const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

describe('public SDK entrypoint', () => {
  it('exports the SDK client version metadata through the public package import', () => {
    expect(sdkClientVersionHeaderName).toBe('x-402flow-sdk-version');
    expect(sdkClientVersion).toBe(packageJson.version);
  });

  it('exports receipt finality schemas through the public package import', () => {
    const receipt = sdkReceiptSchema.parse({
      receiptId: '00000000-0000-0000-0000-000000000030',
      paidRequestId: '00000000-0000-0000-0000-000000000130',
      paymentAttemptId: '00000000-0000-0000-0000-000000000230',
      organizationId: '00000000-0000-0000-0000-000000000001',
      agentId: '00000000-0000-0000-0000-000000000002',
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
      reconciliationStatus: 'resolved',
      confirmationSource: 'chain_observer',
      attributionStrength: 'constrained_unique',
      attributionBasis: {
        transferFingerprint: '0xabc:7',
        payerAddress: '0x1234',
      },
      attributionRuleVersion: 'evm-x402-v1',
      confirmedAt: '2026-03-10T00:00:01.000Z',
      finalityLevelUsed: 'evm_block_confirmations_12',
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
    if (decision.outcome !== 'allow') {
      throw new Error('Expected allow decision.');
    }
    expect(decision.receipt.status).toBe('confirmed');
    expect(decision.receipt.merchantId).toBeUndefined();
    expect(decision.receipt.confirmationSource).toBe('chain_observer');
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
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      {
        challenge: {
          protocol: 'x402',
          headers: {},
          body: {
            syntheticExecutionMode: 'mock',
          },
        },
      },
    );

    expect(result.kind).toBe('success');
  });

  it('throws FetchPaidError for denied x402 challenge paths through the public package import', async () => {
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
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        challenge: {
          protocol: 'x402',
          headers: {},
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('denied');
    expect(error.policyReviewEventId).toBe('00000000-0000-0000-0000-000000000031');
  });

  it('parses challenge-selection denial reason codes through the public package import', () => {
    const decision = sdkPaymentDecisionResponseSchema.parse({
      outcome: 'deny',
      paidRequestId: '00000000-0000-0000-0000-000000000132',
      reasonCode: 'challenge_execution_identity_ambiguous',
      reason: 'Multiple executable wallets match the resolved supported method.',
    });

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') {
      throw new Error('Expected deny decision.');
    }
    expect(decision.reasonCode).toBe('challenge_execution_identity_ambiguous');
  });
});