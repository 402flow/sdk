import { describe, expect, it } from 'vitest';

import { createMockClient } from './mock-client.mjs';

describe('openai harness mock client', () => {
  it('returns prepare results and throws FetchPaidError for denied execute outcomes', async () => {
    const client = createMockClient({
      prepareResult: {
        kind: 'ready',
        protocol: 'x402',
      },
      executeOutcome: {
        kind: 'denied',
        protocol: 'x402',
        response: {
          status: 403,
          headers: {
            'content-type': 'application/json',
          },
          body: {
            outcome: 'deny',
            reasonCode: 'policy_denied',
            reason: 'Policy denied.',
          },
        },
        reason: 'Policy denied.',
        decision: {
          outcome: 'deny',
          reasonCode: 'policy_denied',
          reason: 'Policy denied.',
        },
      },
    });

    await expect(client.preparePaidRequest()).resolves.toEqual({
      kind: 'ready',
      protocol: 'x402',
    });

    const error = await client.executePreparedRequest().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FetchPaidError');
    expect(error.kind).toBe('denied');
    expect(error.response.status).toBe(403);
    expect(error.reason).toBe('Policy denied.');
  });
});