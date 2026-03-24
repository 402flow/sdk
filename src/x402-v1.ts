import {
  createParsedChallengeFromExplicitHeaders,
  createParsedChallengeFromPaymentRequired,
  decodeBase64JsonObject,
  isRecord,
  isX402PaymentRequired,
  type X402PaymentResponse,
} from './challenge-types.js';

export function parseX402V1HeaderChallenge(response: Response) {
  const protocolHeader = response.headers.get('x-payment-protocol');
  const amountHeader = response.headers.get('x-payment-amount');
  const assetHeader = response.headers.get('x-payment-asset');

  if (!protocolHeader || !amountHeader || !assetHeader) {
    return undefined;
  }

  return createParsedChallengeFromExplicitHeaders({
    protocol: protocolHeader.toLowerCase() as 'x402' | 'l402',
    amount: amountHeader,
    asset: assetHeader,
    precision: Number(response.headers.get('x-payment-precision') ?? '6'),
    ...(response.headers.get('x-payment-payee')
      ? { payee: response.headers.get('x-payment-payee') as string }
      : {}),
    raw: {
      headers: {
        'x-payment-protocol': protocolHeader,
        'x-payment-amount': amountHeader,
        'x-payment-asset': assetHeader,
      },
    },
  });
}

export function parseX402V1BodyChallenge(candidate: unknown) {
  if (!isX402PaymentRequired(candidate) || candidate.x402Version !== 1) {
    return undefined;
  }

  return createParsedChallengeFromPaymentRequired({
    protocol: 'x402',
    paymentRequired: candidate,
    raw: {
      paymentRequired: candidate,
    },
  });
}

export function parseX402V1PaymentResponseHeader(headerValue: string | null) {
  if (!headerValue) {
    return undefined;
  }

  try {
    const decodedHeader = decodeBase64JsonObject(headerValue);

    if (!isRecord(decodedHeader)) {
      return undefined;
    }

    return decodedHeader as X402PaymentResponse;
  } catch {
    return undefined;
  }
}