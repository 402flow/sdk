import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  type DetectedChallenge,
} from '@402flow/sdk';

import { baseReceipt } from './agent-pay-client.test-fixtures.js';

const challenge: DetectedChallenge = {
  protocol: 'x402',
  headers: { 'x-payment-protocol': 'x402' },
};
const clientOptions = {
  controlPlaneBaseUrl: 'https://control.example.test',
  organization: 'retry-tests',
  agent: 'retry-agent',
  auth: {
    type: 'runtimeToken' as const,
    runtimeToken: 'test-token',
  },
};

function allowResponse() {
  return new Response(JSON.stringify({
    outcome: 'allow',
    paidRequestId: baseReceipt.paidRequestId,
    paymentAttemptId: baseReceipt.paymentAttemptId,
    reasonCode: 'policy_allow',
    reason: 'Allowed.',
    merchantResponse: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    },
    receipt: baseReceipt,
  }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

describe('retry, idempotency, and abort behavior', () => {
  it('forwards the same idempotency key on an exact caller-controlled retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () => allowResponse(),
    );
    const client = new AgentPayClient({ ...clientOptions, fetch: fetchMock });
    const request = {
      challenge,
      description: 'same business operation',
      idempotencyKey: 'report:2026-07-26',
    };

    const first = await client.fetchPaid(
      'https://merchant.example.test/report',
      { method: 'POST', body: '{"report":"daily"}' },
      request,
    );
    const second = await client.fetchPaid(
      'https://merchant.example.test/report',
      { method: 'POST', body: '{"report":"daily"}' },
      request,
    );

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const call of fetchMock.mock.calls) {
      const init = call[1];
      expect(init?.body).toBeTypeOf('string');
      const body = JSON.parse(String(init?.body)) as {
        idempotencyKey?: string;
      };
      expect(body.idempotencyKey).toBe('report:2026-07-26');
    }
  });

  it('does not hide a control-plane transport failure behind an automatic retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('control plane unavailable'),
    );
    const client = new AgentPayClient({ ...clientOptions, fetch: fetchMock });

    await expect(client.fetchPaid(
      'https://merchant.example.test/report',
      undefined,
      { challenge, idempotencyKey: 'report:transport-loss' },
    )).rejects.toThrow(/Control plane request.*failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards an already-aborted signal to the merchant probe', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        if (init?.signal?.aborted) {
          throw init.signal.reason;
        }
        return new Response('ok');
      },
    );
    const client = new AgentPayClient({ ...clientOptions, fetch: fetchMock });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    await expect(client.preparePaidRequest(
      'https://merchant.example.test/slow',
      { signal: controller.signal },
    )).rejects.toThrow('caller cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
