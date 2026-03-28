import type { PaidRequestProtocol } from './contracts.js';

export type DetectedChallenge = {
  protocol: PaidRequestProtocol;
  headers: Record<string, string>;
  body?: unknown;
};

export async function detectChallengeFromResponse(
  response: Response,
): Promise<DetectedChallenge | undefined> {
  const headers = captureHeaders(response.headers);
  const protocol = sniffProtocolFromHeaders(headers);

  if (protocol) {
    const body = await tryReadJsonBody(response);

    return body !== undefined
      ? { protocol, headers, body }
      : { protocol, headers };
  }

  const body = await tryReadJsonBody(response);

  if (body !== undefined) {
    const bodyProtocol = sniffProtocolFromBody(body);

    if (bodyProtocol) {
      return { protocol: bodyProtocol, headers, body };
    }
  }

  return undefined;
}

function captureHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};

  source.forEach((value, key) => {
    headers[key] = value;
  });

  return headers;
}

function sniffProtocolFromHeaders(
  headers: Record<string, string>,
): PaidRequestProtocol | undefined {
  if (headers['payment-required']) {
    return 'x402';
  }

  const paymentProtocol = headers['x-payment-protocol']?.toLowerCase();

  if (paymentProtocol === 'x402' || paymentProtocol === 'l402') {
    return paymentProtocol;
  }

  const authenticate = headers['www-authenticate'];

  if (authenticate) {
    const match = authenticate.match(/\b(x402|l402)\b/i);

    if (match) {
      return match[1]!.toLowerCase() as PaidRequestProtocol;
    }
  }

  return undefined;
}

function sniffProtocolFromBody(
  payload: unknown,
): PaidRequestProtocol | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate =
    'challenge' in payload &&
    payload.challenge &&
    typeof payload.challenge === 'object'
      ? payload.challenge
      : payload;

  if ('x402Version' in candidate) {
    return 'x402';
  }

  if ('protocol' in candidate && typeof candidate.protocol === 'string') {
    const protocol = candidate.protocol.toLowerCase();

    if (protocol === 'x402' || protocol === 'l402') {
      return protocol;
    }
  }

  return undefined;
}

async function tryReadJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    return undefined;
  }

  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}
