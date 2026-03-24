import {
  createParsedChallengeFromPaymentRequired,
  decodeBase64JsonObject,
  isRecord,
  isX402PaymentRequired,
  type X402PaymentResponse,
} from './challenge-types.js';

export function parseX402V2HeaderChallenge(response: Response) {
  const paymentRequiredHeader = response.headers.get('payment-required');

  if (!paymentRequiredHeader) {
    return undefined;
  }

  try {
    const decodedHeader = decodeBase64JsonObject(paymentRequiredHeader);

    if (!isX402PaymentRequired(decodedHeader) || decodedHeader.x402Version !== 2) {
      return undefined;
    }

    return createParsedChallengeFromPaymentRequired({
      protocol: 'x402',
      paymentRequired: decodedHeader,
      raw: {
        paymentRequiredHeader,
        paymentRequired: decodedHeader,
      },
    });
  } catch {
    return undefined;
  }
}

export function parseX402V2BodyChallenge(candidate: unknown) {
  if (!isX402PaymentRequired(candidate) || candidate.x402Version !== 2) {
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

export function parseX402V2PaymentResponseHeader(headerValue: string | null) {
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