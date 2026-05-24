import { describe, expect, it, vi } from 'vitest';

import {
  AgentPayClient,
  FetchPaidError,
} from '../src/index.js';

import {
  baseChallenge,
  baseContext,
  baseReceipt,
} from './agent-pay-client.test-fixtures.js';

describe('AgentPayClient integration flows', () => {

  it('prepares a paid request with normalized challenge terms and external metadata hints', async () => {
    const paymentRequired = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: 'https://merchant.example.com/paid',
        description: 'Merchant challenge description',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': paymentRequiredHeader,
          },
        }),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"prompt":"hello"}',
      },
      {
        externalMetadata: {
          description: 'External metadata description',
          requestBodyType: 'json',
          requestBodyFields: [
            {
              name: 'prompt',
              type: 'string',
              required: true,
            },
            {
              name: 'debug',
              type: 'boolean',
            },
          ],
          notes: ['External metadata note'],
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }

    expect(prepared.protocol).toBe('x402');
    expect(prepared.request.bodyHash).toBe(
      '8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4',
    );
    expect(prepared.paymentRequirement).toMatchObject({
      protocol: 'x402',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'eip155:84532',
      payee: '0xmerchant',
      amountMinor: '1000000',
      amount: '1.000000',
      precision: 6,
      amountType: 'exact',
      provenance: {
        source: 'merchant_challenge',
        authority: 'authoritative',
      },
    });
    expect(prepared.hints.description).toEqual({
      value: 'External metadata description',
      attribution: {
        source: 'external_metadata',
        authority: 'advisory',
      },
    });
    expect(prepared.hints.requestBodyFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'prompt',
          attribution: {
            source: 'external_metadata',
            authority: 'advisory',
          },
        }),
        expect.objectContaining({
          name: 'debug',
          attribution: {
            source: 'external_metadata',
            authority: 'advisory',
          },
        }),
      ]),
    );
    expect(prepared.hints.notes).toEqual([
      {
        value: 'External metadata note',
        attribution: {
          source: 'external_metadata',
          authority: 'advisory',
        },
      },
    ]);
    expect(prepared.validationIssues).toEqual([]);
    expect(prepared.nextAction).toBe('execute');
  });

  it('returns a passthrough preparation result when probing finds no payment challenge', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () => new Response('ok', { status: 200 }),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/free',
      { method: 'GET' },
    );

    expect(prepared).toMatchObject({
      kind: 'passthrough',
      protocol: 'none',
      probe: {
        responseStatus: 200,
      },
      validationIssues: [],
      nextAction: 'treat_as_passthrough',
    });
  });

  it('derives validation issues and revise_request when required body fields are missing', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': paymentRequiredHeader,
          },
        }),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          prompt: 'hello',
        }),
      },
      {
        externalMetadata: {
          requestBodyType: 'json',
          requestBodyFields: [
            {
              name: 'prompt',
              type: 'string',
              required: true,
            },
            {
              name: 'style',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    );

    expect(prepared.validationIssues).toEqual([
      {
        location: 'body',
        field: 'style',
        code: 'missing_required_field',
        message: 'Required request body field "style" is missing.',
        source: 'external_metadata',
        blocking: true,
        severity: 'error',
        suggestedFix: 'Add the required body field "style" before execution.',
      },
    ]);
    expect(prepared.nextAction).toBe('revise_request');
  });

  it('prefers merchant challenge hints over overlapping external metadata', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
      extensions: {
        bazaar: {
          schema: {
            type: 'object',
            properties: {
              input: {
                type: 'object',
                properties: {
                  bodyType: { const: 'json' },
                  body: {
                    type: 'object',
                    properties: {
                      prompt: {
                        type: 'string',
                        description: 'Merchant prompt field.',
                      },
                    },
                    required: ['prompt'],
                  },
                },
              },
            },
          },
        },
      },
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': paymentRequiredHeader,
          },
        }),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"prompt":"hello"}',
      },
      {
        externalMetadata: {
          requestBodyType: 'text',
          requestBodyFields: [
            {
              name: 'prompt',
              type: 'boolean',
              description: 'External prompt field.',
            },
            {
              name: 'style',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    );

    expect(prepared.hints.requestBodyType).toEqual({
      value: 'json',
      attribution: {
        source: 'merchant_challenge',
        authority: 'authoritative',
      },
    });
    expect(prepared.hints.requestBodyFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'prompt',
          type: 'string',
          description: 'Merchant prompt field.',
          attribution: {
            source: 'merchant_challenge',
            authority: 'authoritative',
          },
        }),
        expect.objectContaining({
          name: 'style',
          attribution: {
            source: 'external_metadata',
            authority: 'advisory',
          },
        }),
      ]),
    );
  });

  it('derives required body fields from merchant challenge schema metadata', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
      extensions: {
        bazaar: {
          info: {
            input: {
              type: 'http',
              method: 'POST',
              bodyType: 'json',
              body: {
                jsonrpc: '2.0',
                method: 'eth_blockNumber',
                params: [],
                id: 1,
              },
            },
          },
          schema: {
            type: 'object',
            properties: {
              input: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                  },
                  method: {
                    type: 'string',
                  },
                  bodyType: {
                    type: 'string',
                    const: 'json',
                  },
                  body: {
                    type: 'object',
                    properties: {
                      jsonrpc: {
                        type: 'string',
                      },
                      method: {
                        type: 'string',
                      },
                      params: {
                        type: 'array',
                      },
                      id: {
                        type: ['number', 'string'],
                      },
                    },
                    required: ['jsonrpc', 'method'],
                  },
                },
              },
            },
          },
        },
      },
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': paymentRequiredHeader,
          },
        }),
    );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
        }),
      },
    );

    expect(prepared.hints.requestBodyType).toEqual({
      value: 'json',
      attribution: {
        source: 'merchant_challenge',
        authority: 'authoritative',
      },
    });
    expect(prepared.hints.requestBodyFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'jsonrpc',
          required: true,
          attribution: {
            source: 'merchant_challenge',
            authority: 'authoritative',
          },
        }),
        expect.objectContaining({
          name: 'method',
          required: true,
          attribution: {
            source: 'merchant_challenge',
            authority: 'authoritative',
          },
        }),
      ]),
    );
    expect(prepared.hints.requestBodyExample).toEqual({
      value: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      attribution: {
        source: 'merchant_challenge',
        authority: 'authoritative',
      },
    });
    expect(prepared.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: 'body',
          field: 'method',
          code: 'missing_required_field',
          source: 'merchant_challenge',
          blocking: true,
        }),
      ]),
    );
    expect(prepared.nextAction).toBe('revise_request');
  });

  it('executes a prepared paid request without re-probing the merchant', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response('{}', {
          status: 402,
          headers: { 'payment-required': paymentRequiredHeader },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000150',
            paymentAttemptId: '00000000-0000-0000-0000-000000000250',
            reasonCode: 'policy_allow',
            reason: 'Allowed.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000150',
              paymentAttemptId: '00000000-0000-0000-0000-000000000250',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      { method: 'GET' },
    );

    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }

    const result = await client.executePreparedRequest(prepared, {});

    expect(result.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:3001/api/sdk/payment-decisions',
    );
  });

  it('authorizes, delegates, and finalizes when executePreparedRequest receives an executor', async () => {
    const paymentRequired = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '1000000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0xmerchant',
          extra: {
            precision: 6,
          },
        },
      ],
    };
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify(paymentRequired),
      'utf8',
    ).toString('base64');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response('{}', {
            status: 402,
            headers: {
              'payment-required': paymentRequiredHeader,
            },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'authorized',
              paidRequestId: '00000000-0000-0000-0000-000000000151',
              paymentAttemptId: '00000000-0000-0000-0000-000000000251',
              reasonCode: 'policy_allow',
              reason: 'Allowed.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'allow',
              paidRequestId: '00000000-0000-0000-0000-000000000151',
              paymentAttemptId: '00000000-0000-0000-0000-000000000251',
              reasonCode: 'policy_allow',
              reason: 'Allowed.',
              merchantResponse: {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                },
                body: '{"ok":true}',
              },
              receipt: {
                ...baseReceipt,
                paidRequestId: '00000000-0000-0000-0000-000000000151',
                paymentAttemptId: '00000000-0000-0000-0000-000000000251',
              },
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
    const executor = {
      provider: 'dexter',
      execute: vi.fn(async () => ({
        protocol: 'x402' as const,
        executionStatus: 'succeeded' as const,
        settlementEvidenceClass: 'settled' as const,
        merchantOutcome: 'success_response' as const,
        merchantResponse: {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
          body: '{"ok":true}',
        },
        settlementReference: 'settlement-ref-1',
        paymentReference: 'payment-ref-1',
      })),
    };
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const prepared = await client.preparePaidRequest(
      'https://merchant.example.com/paid',
      { method: 'GET' },
    );

    if (prepared.kind !== 'ready') {
      throw new Error(`Unexpected prepared kind: ${prepared.kind}`);
    }

    const result = await client.executePreparedRequest(prepared, {
      executionProvider: 'dexter',
      executor,
    });

    expect(result.kind).toBe('success');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:3001/api/sdk/payment-authorizations',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'http://localhost:3001/api/sdk/payment-finalizations',
    );
  });

  it('propagates merchant fetch transport failures before challenge detection', async () => {
    const transportError = new TypeError('fetch failed');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(transportError);
    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/unreachable', { method: 'GET' }, {
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(transportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws policy review denials with the review event id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000130',
            reasonCode: 'policy_review_required',
            reason: 'Policy review required.',
            policyReviewEventId: '00000000-0000-0000-0000-000000000031',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('denied');
    expect(error.policyReviewEventId).toBe('00000000-0000-0000-0000-000000000031');
    expect(error.reason).toBe('Policy review required.');
  });

  it('parses deny decisions that report mixed testnet and mainnet candidates', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'deny',
            paidRequestId: '00000000-0000-0000-0000-000000000131',
            reasonCode: 'challenge_mixed_environment_candidates',
            reason:
              'This merchant offered supported x402 payment candidates across both testnet and mainnet environments.',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }

    expect(error.kind).toBe('denied');
    expect(error.reason).toContain('both testnet and mainnet environments');
    expect(error.decision?.outcome).toBe('deny');
    expect(error.decision?.reasonCode).toBe(
      'challenge_mixed_environment_candidates',
    );
  });

  it('throws request_failed errors when the control plane rejects the request selectors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            message: 'Payment decision request rejected.',
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/data', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('request_failed');
    expect(error.reason).toBe('Payment decision request rejected.');
    expect(error.response.status).toBe(404);
  });

  it('formats control-plane validation issues into request_failed errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            message: 'Invalid SDK payment decision request.',
            issues: {
              formErrors: [],
              fieldErrors: {
                request: ['Invalid url'],
              },
            },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/data', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('request_failed');
    expect(error.reason).toBe(
      'Invalid SDK payment decision request. request: Invalid url',
    );
    expect(error.response.status).toBe(400);
  });

  it('throws structured execution failures when the control plane returns non-ok JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000140',
            paymentAttemptId: '00000000-0000-0000-0000-000000000240',
            reasonCode: 'merchant_rejected',
            reason: 'Merchant rejected the paid request.',
            merchantResponse: {
              status: 402,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"payment required"}',
            },
            evidence: {
              rejectionSource: 'merchant',
            },
          }),
          {
            status: 402,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('execution_failed');
    expect(error.reason).toBe('Merchant rejected the paid request.');
    expect(error.decision.reasonCode).toBe('merchant_rejected');
  });

  it('throws merchant execution errors separately from merchant rejections', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'execution_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000141',
            paymentAttemptId: '00000000-0000-0000-0000-000000000241',
            reasonCode: 'merchant_execution_failed',
            reason: 'Merchant returned 500 during paid execution.',
            merchantResponse: {
              status: 500,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"upstream unavailable"}',
            },
            evidence: {
              merchantStatus: 500,
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/premium', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('execution_failed');
    expect(error.reason).toBe('Merchant returned 500 during paid execution.');
    expect(error.decision.reasonCode).toBe('merchant_execution_failed');
  });

  it('returns delivered merchant responses with a provisional receipt on allow outcomes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'allow',
            paidRequestId: '00000000-0000-0000-0000-000000000150',
            paymentAttemptId: '00000000-0000-0000-0000-000000000250',
            reasonCode: 'settlement_proof_conflict',
            reason: 'Merchant delivered the response while settlement attribution remains ambiguous.',
            merchantResponse: {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"ok":true,"replay":"stable"}',
            },
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000150',
              paymentAttemptId: '00000000-0000-0000-0000-000000000250',
              status: 'provisional',
              reconciliationStatus: 'required',
              canonicalSettlementKey: 'merchant-ref:ambiguous-150',
              settlementEvidenceClass: 'merchant_verifiable_success',
              fulfillmentStatus: 'succeeded',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const result = await client.fetchPaid(
      'https://merchant.example.com/data',
      { method: 'GET' },
      { challenge: baseChallenge },
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.receipt.status).toBe('provisional');
    expect(result.receipt.reconciliationStatus).toBe('required');
    expect(result.receipt.canonicalSettlementKey).toBe(
      'merchant-ref:ambiguous-150',
    );
    await expect(result.response.text()).resolves.toBe(
      '{"ok":true,"replay":"stable"}',
    );
  });

  it('throws paid fulfillment failures with provisional receipts when payment likely succeeded', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            outcome: 'paid_fulfillment_failed',
            paidRequestId: '00000000-0000-0000-0000-000000000151',
            paymentAttemptId: '00000000-0000-0000-0000-000000000251',
            reasonCode: 'merchant_execution_failed',
            reason: 'Merchant reported fulfillment failure after a paid path was observed.',
            merchantResponse: {
              status: 502,
              headers: {
                'content-type': 'application/json',
              },
              body: '{"error":"upstream unavailable"}',
            },
            settlementEvidenceClass: 'merchant_verifiable_success',
            fulfillmentStatus: 'failed',
            receipt: {
              ...baseReceipt,
              paidRequestId: '00000000-0000-0000-0000-000000000151',
              paymentAttemptId: '00000000-0000-0000-0000-000000000251',
              status: 'provisional',
              reconciliationStatus: 'required',
              settlementEvidenceClass: 'merchant_verifiable_success',
              fulfillmentStatus: 'failed',
            },
            evidence: {
              merchantStatus: 502,
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const error = await client
      .fetchPaid('https://merchant.example.com/data', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FetchPaidError);
    if (!(error instanceof FetchPaidError)) {
      throw error;
    }
    expect(error.kind).toBe('paid_fulfillment_failed');
    expect(error.receipt?.status).toBe('provisional');
    expect(error.receipt?.reconciliationStatus).toBe('required');
    expect(error.decision.merchantResponse.body).toBe(
      '{"error":"upstream unavailable"}',
    );
    await expect(error.response.text()).resolves.toBe(
      '{"error":"upstream unavailable"}',
    );
  });

  it('keeps receipt identity and merchant response bodies deterministic across replayed decisions', async () => {
    const replayDecision = {
      outcome: 'allow',
      paidRequestId: '00000000-0000-0000-0000-000000000152',
      paymentAttemptId: '00000000-0000-0000-0000-000000000252',
      reasonCode: 'settlement_proof_conflict',
      reason: 'Replaying durable merchant success with provisional receipt.',
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-replay-source': 'durable-attempt',
        },
        body: '{"result":"stable"}',
      },
      receipt: {
        ...baseReceipt,
        paidRequestId: '00000000-0000-0000-0000-000000000152',
        paymentAttemptId: '00000000-0000-0000-0000-000000000252',
        status: 'provisional',
        reconciliationStatus: 'required',
        canonicalSettlementKey: 'merchant-ref:replay-152',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(replayDecision), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(replayDecision), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const first = await client.fetchPaid(
      'https://merchant.example.com/replay',
      { method: 'GET' },
      { challenge: baseChallenge },
    );
    const second = await client.fetchPaid(
      'https://merchant.example.com/replay',
      { method: 'GET' },
      { challenge: baseChallenge },
    );

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') {
      throw new Error('Unexpected replay result kind.');
    }
    expect(first.receiptId).toBe(second.receiptId);
    expect(first.receipt.status).toBe('provisional');
    expect(second.receipt.status).toBe('provisional');
    await expect(first.response.text()).resolves.toBe('{"result":"stable"}');
    await expect(second.response.text()).resolves.toBe('{"result":"stable"}');
  });

  it('throws execution progress states as typed SDK errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'executing',
              paidRequestId: '00000000-0000-0000-0000-000000000130',
              paymentAttemptId: '00000000-0000-0000-0000-000000000230',
              reasonCode: 'payment_execution_in_progress',
              reason: 'Still executing.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              outcome: 'inconclusive',
              paidRequestId: '00000000-0000-0000-0000-000000000131',
              paymentAttemptId: '00000000-0000-0000-0000-000000000231',
              reasonCode: 'merchant_transport_lost',
              reason: 'Merchant response lost.',
            }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );

    const client = new AgentPayClient({
      controlPlaneBaseUrl: 'http://localhost:3001',
      auth: { type: 'runtimeToken', runtimeToken: 'runtime-token' },
      ...baseContext,
      fetch: fetchMock,
    });

    const executing = await client
      .fetchPaid('https://merchant.example.com/pending', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);
    const inconclusive = await client
      .fetchPaid('https://merchant.example.com/inconclusive', { method: 'GET' }, {
        challenge: baseChallenge,
      })
      .catch((caught: unknown) => caught);

    expect(executing).toBeInstanceOf(FetchPaidError);
    if (!(executing instanceof FetchPaidError)) {
      throw executing;
    }
    expect(executing.kind).toBe('execution_pending');
    expect(executing.response.status).toBe(202);
    expect(executing.reason).toBe('Still executing.');

    expect(inconclusive).toBeInstanceOf(FetchPaidError);
    if (!(inconclusive instanceof FetchPaidError)) {
      throw inconclusive;
    }
    expect(inconclusive.kind).toBe('execution_inconclusive');
    expect(inconclusive.response.status).toBe(202);
    expect(inconclusive.reason).toBe('Merchant response lost.');
  });
});
