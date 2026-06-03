import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  createAgentPayClient,
  sdkClientVersion,
  sdkClientVersionHeaderName,
} from './index.js';
import {
  baseChallenge,
  baseContext,
  baseMoney,
  baseReceipt,
  unsupportedSdkVersionMessage,
} from '../test/agent-pay-client.test-fixtures.js';

describe('AgentPayClient entrypoint behaviors', () => {
  it('passes through a normal fetch when the merchant response is not payable', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      {},
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
      ...baseContext,
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
      { challenge: baseChallenge },
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
    expect(request?.headers).toMatchObject({
      [sdkClientVersionHeaderName]: sdkClientVersion,
    });
    expect(result.receiptId).toBe('00000000-0000-0000-0000-000000000030');
  });

  it('keeps the bound client identity when runtime callers pass identity fields', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000132',
            paymentAttemptId: '00000000-0000-0000-0000-000000000232',
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
              paidRequestId: '00000000-0000-0000-0000-000000000132',
              paymentAttemptId: '00000000-0000-0000-0000-000000000232',
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
    const request = {
      challenge: baseChallenge,
      description: 'Bound identity should win.',
      organization: 'rogue-organization',
      agent: 'rogue-agent',
    } as unknown as Parameters<AgentPayClient['fetchPaid']>[2];

    await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      request,
    );

    const controlPlaneRequest = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(controlPlaneRequest?.body));
    expect(payload.context.organization).toBe(baseContext.organization);
    expect(payload.context.agent).toBe(baseContext.agent);
  });

  it('accepts observed-only receipts that omit merchantId', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000131',
            paymentAttemptId: '00000000-0000-0000-0000-000000000231',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 201,
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
              money: baseMoney,
              authorizationOutcome: 'allowed',
              status: 'confirmed',
              reconciliationStatus: 'none',
              requestUrl: 'https://www.x402.org/protected',
              requestMethod: 'GET',
              createdAt: '2026-03-29T00:00:00.000Z',
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
      'https://www.x402.org/protected',
      { method: 'GET' },
      { challenge: baseChallenge },
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.response.status).toBe(201);
    expect(result.receipt.merchantId).toBeUndefined();
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
      ...baseContext,
      fetch: fetchMock,
    });

    await client.lookupReceipt('00000000-0000-0000-0000-000000000020');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer bootstrap-key',
      [sdkClientVersionHeaderName]: sdkClientVersion,
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer runtime-token',
      [sdkClientVersionHeaderName]: sdkClientVersion,
    });
  });

  it('parses receipt lookups that use Solana finality levels', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            receipt: {
              ...baseReceipt,
              receiptId: '00000000-0000-0000-0000-000000000021',
              paidRequestId: '00000000-0000-0000-0000-000000000121',
              paymentAttemptId: '00000000-0000-0000-0000-000000000221',
              finalityLevelUsed: 'solana_commitment_finalized',
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
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const response = await client.lookupReceipt(
      '00000000-0000-0000-0000-000000000021',
    );

    expect(response.receipt.finalityLevelUsed).toBe('solana_commitment_finalized');
  });

  it('surfaces actionable runtime token exchange errors from the control plane', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            message: unsupportedSdkVersionMessage,
            code: 'unsupported_sdk_version',
            supportedVersions: ['supported-sdk-version'],
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'bootstrapKey', bootstrapKey: 'bootstrap-key' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .lookupReceipt('00000000-0000-0000-0000-000000000020')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toBe(unsupportedSdkVersionMessage);
  });

  it('surfaces an actionable hint when a local control plane base URL uses https by mistake', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'https://127.0.0.1:3001',
      auth: { type: 'bootstrapKey', bootstrapKey: 'bootstrap-key' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .lookupReceipt('00000000-0000-0000-0000-000000000020')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }

    expect(error.message).toContain(
      'Control plane request to https://127.0.0.1:3001/api/sdk/runtime-tokens failed.',
    );
    expect(error.message).toContain(
      'use http://127.0.0.1:3001 as the controlPlaneBaseUrl instead.',
    );
    expect(error.message).toContain('Original error: fetch failed');
  });

  it('detects a v2 payment-required header and forwards the parsed challenge to the control plane', async () => {
    const paymentRequired = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: 'https://merchant.example.com/paid',
        description: 'Paid endpoint',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response('{}', {
          status: 402,
          headers: { 'payment-required': paymentRequiredHeader },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000140',
            paymentAttemptId: '00000000-0000-0000-0000-000000000240',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000140',
              paymentAttemptId: '00000000-0000-0000-0000-000000000240',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/paid',
      { method: 'GET' },
      {},
    );

    expect(result.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const controlPlaneCall = fetchMock.mock.calls[1];
    const controlPlaneBody = JSON.parse(String(controlPlaneCall?.[1]?.body));

    expect(controlPlaneBody.challenge).toMatchObject({
      protocol: 'x402',
      headers: {
        'payment-required': paymentRequiredHeader,
      },
    });
  });

  it('detects a v1 explicit-header challenge and forwards it to the control plane', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response('payment required', {
          status: 402,
          headers: {
            'x-payment-protocol': 'x402',
            'x-payment-amount': '2.500000',
            'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            'x-payment-precision': '6',
            'x-payment-payee': 'merchant-wallet',
          },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000141',
            paymentAttemptId: '00000000-0000-0000-0000-000000000241',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000141',
              paymentAttemptId: '00000000-0000-0000-0000-000000000241',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/paid',
      { method: 'GET' },
      {},
    );

    expect(result.kind).toBe('success');

    const controlPlaneBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    );

    expect(controlPlaneBody.challenge.protocol).toBe('x402');
    expect(controlPlaneBody.challenge.headers).toMatchObject({
      'x-payment-protocol': 'x402',
      'x-payment-amount': '2.500000',
      'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      'x-payment-precision': '6',
      'x-payment-payee': 'merchant-wallet',
    });
  });

  it('detects a www-authenticate challenge and forwards it to the control plane', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response('', {
          status: 402,
          headers: {
            'www-authenticate': 'x402 amount="0.500000" asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e"',
          },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000142',
            paymentAttemptId: '00000000-0000-0000-0000-000000000242',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000142',
              paymentAttemptId: '00000000-0000-0000-0000-000000000242',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/paid',
      { method: 'GET' },
      {},
    );

    expect(result.kind).toBe('success');

    const controlPlaneBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    );

    expect(controlPlaneBody.challenge.protocol).toBe('x402');
    expect(controlPlaneBody.challenge.headers).toMatchObject({
      'www-authenticate': 'x402 amount="0.500000" asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e"',
    });
  });

  it('forwards optional paid-request attribution for direct SDK callers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response('payment required', {
          status: 402,
          headers: {
            'x-payment-protocol': 'x402',
            'x-payment-amount': '0.500000',
            'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            'x-payment-precision': '6',
            'x-payment-payee': 'merchant-wallet',
          },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000152',
            paymentAttemptId: '00000000-0000-0000-0000-000000000252',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000152',
              paymentAttemptId: '00000000-0000-0000-0000-000000000252',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/v1/search?query=ai',
      { method: 'POST' },
      {
        attribution: {
          discoverySource: 'direct',
        },
      },
    );

    expect(result.kind).toBe('success');

    const controlPlaneBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    );

    expect(controlPlaneBody.context.attribution).toEqual({
      discoverySource: 'direct',
    });
  });
});
