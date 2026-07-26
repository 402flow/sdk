import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  detectChallengeFromResponse,
} from '@402flow/sdk';

const clientOptions = {
  controlPlaneBaseUrl: 'https://control.example.test',
  organization: 'compatibility-tests',
  agent: 'migration-agent',
  auth: {
    type: 'runtimeToken' as const,
    runtimeToken: 'test-token',
  },
};

describe('older x402 merchant compatibility', () => {
  it('prepares legacy v1 maxAmountRequired and network alias fields', async () => {
    const client = new AgentPayClient(clientOptions);
    const prepared = await client.preparePaidRequest(
      'https://merchant.example.test/paid',
      { method: 'GET' },
      {
        challenge: {
          protocol: 'x402',
          headers: {},
          body: {
            x402Version: 1,
            accepts: [{
              scheme: 'exact',
              network: 'base-sepolia',
              maxAmountRequired: '1000',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              payTo: '0xmerchant',
            }],
          },
        },
      },
    );

    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }
    expect(prepared.challengeDetails?.x402Version).toBe(1);
    expect(prepared.paymentRequirement).toMatchObject({
      amountMinor: '1000',
      network: 'base-sepolia',
      payee: '0xmerchant',
    });
  });

  it('detects legacy x-payment headers and preserves them for execution', async () => {
    const response = new Response('payment required', {
      status: 402,
      headers: {
        'x-payment-protocol': 'x402',
        'x-payment-amount': '0.001000',
        'x-payment-asset': 'USDC',
        'x-payment-network': 'base-sepolia',
        'x-payment-payee': '0xmerchant',
        'x-payment-precision': '6',
      },
    });

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge).toEqual({
      protocol: 'x402',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'x-payment-amount': '0.001000',
        'x-payment-asset': 'USDC',
        'x-payment-network': 'base-sepolia',
        'x-payment-payee': '0xmerchant',
        'x-payment-precision': '6',
        'x-payment-protocol': 'x402',
      },
    });
  });

  it('keeps the current v2 PAYMENT-REQUIRED shape compatible', async () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'https://merchant.example.test/paid' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '1000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0xmerchant',
      }],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'payment-required': Buffer.from(
            JSON.stringify(payload),
            'utf8',
          ).toString('base64'),
        },
      }),
    );
    const client = new AgentPayClient({ ...clientOptions, fetch: fetchMock });
    const prepared = await client.preparePaidRequest(
      'https://merchant.example.test/paid',
    );

    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }
    expect(prepared.paymentRequirement).toMatchObject({
      amountMinor: '1000',
      network: 'eip155:84532',
    });
  });
});
