import { describe, expect, it } from 'vitest';

import {
  detectChallengeFromResponse,
  getX402PaymentRequired,
  parseX402PaymentResponseHeader,
} from './challenge-detection.js';

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

    await expect(detectChallengeFromResponse(response)).resolves.toEqual({
      protocol: 'x402',
      money: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '2.500000',
        amountMinor: '2500000',
        precision: 6,
        unit: 'minor',
      },
      payee: 'merchant-wallet',
      raw: {
        headers: {
          'x-payment-protocol': 'x402',
          'x-payment-amount': '2.500000',
          'x-payment-asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
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

    await expect(detectChallengeFromResponse(response)).resolves.toEqual({
      protocol: 'x402',
      money: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '1.250000',
        amountMinor: '1250000',
        precision: 6,
        unit: 'minor',
      },
      payee: 'merchant-wallet',
      raw: {
        authenticate:
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

    expect(challenge).toEqual({
      protocol: 'x402',
      money: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '0.001000',
        amountMinor: '1000',
        precision: 6,
        unit: 'minor',
      },
      payee: '0xmerchant',
      raw: {
        paymentRequiredHeader: encodeBase64Json(paymentRequired),
        paymentRequired,
      },
    });

    expect(challenge && getX402PaymentRequired(challenge)).toEqual(paymentRequired);
  });

  it('detects a challenge from a JSON response body', async () => {
    const response = new Response(
      JSON.stringify({
        challenge: {
          protocol: 'l402',
          money: {
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '4.000000',
            amountMinor: '4000000',
            precision: 6,
            unit: 'minor',
          },
          payee: 'lightning-invoice',
          raw: {
            invoice: 'lnbc1example',
          },
        },
      }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json',
        },
      },
    );

    await expect(detectChallengeFromResponse(response)).resolves.toEqual({
      protocol: 'l402',
      money: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '4.000000',
        amountMinor: '4000000',
        precision: 6,
        unit: 'minor',
      },
      payee: 'lightning-invoice',
      raw: {
        invoice: 'lnbc1example',
      },
    });
  });

  it('returns undefined when no supported challenge format is present', async () => {
    const response = new Response('ok', { status: 200 });

    await expect(detectChallengeFromResponse(response)).resolves.toBeUndefined();
  });

  it('decodes a PAYMENT-RESPONSE header payload', () => {
    const paymentResponse = {
      settlementId: 'settlement-123',
      transactionHash: '0xabc',
    };

    expect(
      parseX402PaymentResponseHeader(encodeBase64Json(paymentResponse)),
    ).toEqual(paymentResponse);
  });
});