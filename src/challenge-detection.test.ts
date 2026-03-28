import { describe, expect, it } from 'vitest';

import { detectChallengeFromResponse } from './challenge-detection.js';

function encodeBase64Json(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('sdk challenge detection', () => {
  it('detects a challenge from explicit payment headers', async () => {
    const response = new Response('payment required', {
      status: 402,
      headers: {
        'x-payment-protocol': 'x402',
        'x-payment-amount': '2.500000',
        'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        'x-payment-precision': '6',
        'x-payment-payee': 'merchant-wallet',
      },
    });

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge).toMatchObject({
      protocol: 'x402',
      headers: {
        'x-payment-protocol': 'x402',
        'x-payment-amount': '2.500000',
        'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        'x-payment-precision': '6',
        'x-payment-payee': 'merchant-wallet',
      },
    });
  });

  it('detects a challenge from the www-authenticate header', async () => {
    const response = new Response('payment required', {
      status: 402,
      headers: {
        'www-authenticate':
          'x402 amount="1.250000", asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e", precision="6", payee="merchant-wallet"',
      },
    });

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge).toMatchObject({
      protocol: 'x402',
      headers: {
        'www-authenticate':
          'x402 amount="1.250000", asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e", precision="6", payee="merchant-wallet"',
      },
    });
  });

  it('detects a challenge from a PAYMENT-REQUIRED header', async () => {
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
          amount: '1000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            name: 'USDC',
            version: '2',
          },
        },
      ],
    };

    const response = new Response('{}', {
      status: 402,
      headers: {
        'payment-required': encodeBase64Json(paymentRequired),
      },
    });

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge).toMatchObject({
      protocol: 'x402',
      headers: {
        'payment-required': encodeBase64Json(paymentRequired),
      },
    });
  });

  it('captures the JSON body alongside headers when available', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000',
          asset: '0xtoken',
          payTo: '0xmerchant',
        },
      ],
    };

    const response = new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: {
        'payment-required': encodeBase64Json(paymentRequired),
        'content-type': 'application/json',
      },
    });

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge?.protocol).toBe('x402');
    expect(challenge?.body).toEqual(paymentRequired);
    expect(challenge?.headers['payment-required']).toBe(
      encodeBase64Json(paymentRequired),
    );
  });

  it('detects a challenge from a JSON response body when no headers are present', async () => {
    const response = new Response(
      JSON.stringify({
        challenge: {
          protocol: 'l402',
          invoice: 'lnbc1example',
        },
      }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json',
        },
      },
    );

    const challenge = await detectChallengeFromResponse(response);

    expect(challenge).toMatchObject({
      protocol: 'l402',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        challenge: {
          protocol: 'l402',
          invoice: 'lnbc1example',
        },
      },
    });
  });

  it('returns undefined when no supported challenge format is present', async () => {
    const response = new Response('ok', { status: 200 });

    await expect(detectChallengeFromResponse(response)).resolves.toBeUndefined();
  });
});
