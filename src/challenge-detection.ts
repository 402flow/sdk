import {
  createParsedChallenge,
  getX402PaymentRequired,
  type ParsedChallenge,
} from './challenge-types.js';
import {
  parseX402V1BodyChallenge,
  parseX402V1HeaderChallenge,
  parseX402V1PaymentResponseHeader,
} from './x402-v1.js';
import {
  parseX402V2BodyChallenge,
  parseX402V2HeaderChallenge,
  parseX402V2PaymentResponseHeader,
} from './x402-v2.js';
import { monetaryAmountToMinorUnits, normalizedMoneySchema } from './contracts.js';

export async function detectChallengeFromResponse(response: Response) {
  const v2HeaderChallenge = parseX402V2HeaderChallenge(response);

  if (v2HeaderChallenge) {
    return v2HeaderChallenge;
  }

  const v1HeaderChallenge = parseX402V1HeaderChallenge(response);

  if (v1HeaderChallenge) {
    return v1HeaderChallenge;
  }

  const authenticateChallenge = parseAuthenticateHeader(
    response.headers.get('www-authenticate'),
  );

  if (authenticateChallenge) {
    return authenticateChallenge;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    return undefined;
  }

  try {
    const payload = await response.clone().json();

    return parseBodyChallenge(payload);
  } catch {
    return undefined;
  }
}

export function parseX402PaymentResponseFromHeaders(
  headers: Headers | Record<string, string>,
) {
  const headerMap = headers instanceof Headers ? headers : new Headers(headers);
  const v2Header = headerMap.get('payment-response');

  if (v2Header) {
    return parseX402V2PaymentResponseHeader(v2Header);
  }

  const v1Header = headerMap.get('x-payment-response');

  if (v1Header) {
    return parseX402V1PaymentResponseHeader(v1Header);
  }

  return undefined;
}

export function parseX402PaymentResponseHeader(headerValue: string | null) {
  return (
    parseX402V2PaymentResponseHeader(headerValue) ??
    parseX402V1PaymentResponseHeader(headerValue)
  );
}

function parseAuthenticateHeader(headerValue: string | null) {
  if (!headerValue) {
    return undefined;
  }

  const protocolMatch = headerValue.match(/\b(x402|l402)\b/i);

  if (!protocolMatch) {
    return undefined;
  }

  const protocol = protocolMatch[1]?.toLowerCase() as 'x402' | 'l402';
  const attributePattern = /(amount|asset|precision|payee)="([^"]+)"/gi;
  const attributes: Record<string, string> = {};
  let match = attributePattern.exec(headerValue);

  while (match) {
    const attributeName = match[1];
    const attributeValue = match[2];

    if (attributeName && attributeValue) {
      attributes[attributeName.toLowerCase()] = attributeValue;
    }

    match = attributePattern.exec(headerValue);
  }

  if (!attributes.amount || !attributes.asset) {
    return undefined;
  }

  return createParsedChallenge({
    protocol,
    money: normalizedMoneySchema.parse({
      asset: attributes.asset,
      amount: attributes.amount,
      amountMinor: monetaryAmountToMinorUnits(
        attributes.amount,
        Number(attributes.precision ?? '6'),
      ),
      precision: Number(attributes.precision ?? '6'),
      unit: 'minor',
    }),
    payee: attributes.payee,
    raw: {
      authenticate: headerValue,
    },
  });
}

function parseBodyChallenge(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate =
    'challenge' in payload && payload.challenge && typeof payload.challenge === 'object'
      ? payload.challenge
      : payload;

  const v2Challenge = parseX402V2BodyChallenge(candidate);

  if (v2Challenge) {
    return v2Challenge;
  }

  const v1Challenge = parseX402V1BodyChallenge(candidate);

  if (v1Challenge) {
    return v1Challenge;
  }

  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const protocol =
    'protocol' in candidate && typeof candidate.protocol === 'string'
      ? candidate.protocol.toLowerCase()
      : undefined;
  const money = 'money' in candidate ? candidate.money : undefined;
  const payee =
    'payee' in candidate && typeof candidate.payee === 'string'
      ? candidate.payee
      : undefined;
  const raw =
    'raw' in candidate && candidate.raw && typeof candidate.raw === 'object'
      ? (candidate.raw as Record<string, unknown>)
      : undefined;

  if ((protocol !== 'x402' && protocol !== 'l402') || !money) {
    return undefined;
  }

  return createParsedChallenge({
    protocol,
    money: normalizedMoneySchema.parse(money),
    payee,
    raw: raw ?? (candidate as Record<string, unknown>),
  });
}

export { getX402PaymentRequired, type ParsedChallenge };