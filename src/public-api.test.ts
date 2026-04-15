import { describe, expect, it, vi } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

import {
  AgentPayClient,
  AgentHarness,
  FetchPaidError,
  createFormUrlEncodedBody,
  createAgentPayClient,
  createJsonRequestBody,
  isReplayableRequestBody,
  sdkClientVersion,
  sdkClientVersionHeaderName,
  sdkPaymentDecisionResponseSchema,
  sdkReceiptSchema,
  toReplayableRequestBody,
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

  it('exports the deterministic harness through the public package import', () => {
    expect(AgentHarness).toBeTypeOf('function');
  });

  it('exports replayable body helpers through the public package import', () => {
    expect(createJsonRequestBody({ prompt: 'hello' })).toBe(
      '{"prompt":"hello"}',
    );

    const formBody = createFormUrlEncodedBody({
      prompt: 'hello',
      attempts: 2,
      tags: ['alpha', 'beta'],
      dryRun: false,
    });

    expect(formBody.toString()).toBe(
      'prompt=hello&attempts=2&tags=alpha&tags=beta&dryRun=false',
    );
    expect(isReplayableRequestBody(formBody)).toBe(true);
    expect(toReplayableRequestBody(formBody)).toBe(
      'prompt=hello&attempts=2&tags=alpha&tags=beta&dryRun=false',
    );
    expect(() => toReplayableRequestBody(new FormData())).toThrow(
      /createJsonRequestBody|createFormUrlEncodedBody/,
    );
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

  it('accepts Solana mint addresses in allow decision receipts through the public package import', () => {
    const decision = sdkPaymentDecisionResponseSchema.parse({
      outcome: 'allow',
      paidRequestId: '00000000-0000-0000-0000-000000000131',
      paymentAttemptId: '00000000-0000-0000-0000-000000000231',
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
        receiptId: '00000000-0000-0000-0000-000000000031',
        paidRequestId: '00000000-0000-0000-0000-000000000131',
        paymentAttemptId: '00000000-0000-0000-0000-000000000231',
        organizationId: '00000000-0000-0000-0000-000000000001',
        agentId: '00000000-0000-0000-0000-000000000002',
        protocol: 'x402',
        money: {
          asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          amount: '0.001000',
          amountMinor: '1000',
          precision: 6,
          unit: 'minor',
        },
        authorizationOutcome: 'allowed',
        status: 'provisional',
        reconciliationStatus: 'none',
        requestUrl: 'https://merchant.example.com/data',
        requestMethod: 'GET',
        createdAt: '2026-03-10T00:00:00.000Z',
      },
    });

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') {
      throw new Error('Expected allow decision.');
    }
    expect(decision.receipt.money.asset).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
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

  it('supports preparing a payable request before execution through the public package import', async () => {
    const paymentRequired = {
      x402Version: 2,
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
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': paymentRequiredHeader,
          },
        }),
    );
    const client = createAgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/data',
      { method: 'POST', body: '{"prompt":"hello"}' },
      {
        externalMetadata: {
          requestBodyFields: [
            {
              name: 'prompt',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    );

    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }
    expect(prepared.paymentRequirement?.provenance.source).toBe(
      'merchant_challenge',
    );
    expect(prepared.hints.requestBodyFields[0]?.attribution.source).toBe(
      'external_metadata',
    );
    expect(prepared.validationIssues).toEqual([]);
    expect(prepared.nextAction).toBe('execute');
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