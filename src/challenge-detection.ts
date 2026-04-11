/**
 * Detects whether an unpaid merchant response is actually a payable challenge and,
 * if so, which paid-request protocol it speaks.
 */
import type { PaidRequestProtocol } from './contracts.js';

/** Minimal challenge shape the rest of the SDK needs in order to proceed. */
export type DetectedChallenge = {
  protocol: PaidRequestProtocol;
  headers: Record<string, string>;
  body?: unknown;
};

/**
 * Inspect a merchant response for x402/l402 challenge evidence in either headers
 * or a JSON body. The SDK prefers header evidence first because that is the most
 * direct live protocol signal.
 */
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

// Header detection is the primary path because a real payable merchant usually
// signals the protocol directly in response headers.
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

// Some compatibility merchants embed the challenge in JSON instead of, or in
// addition to, headers. This fallback keeps the client tolerant of that shape.
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

// The detector only parses JSON bodies when content-type says JSON, and it never
// consumes the original response stream thanks to clone().
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
