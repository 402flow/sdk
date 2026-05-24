import { describe, expect, it, vi } from 'vitest';

import { AgentHarness } from './agent-harness.js';
import {
  baseReceipt,
  createPassthroughPrepared,
  createReadyPrepared,
  createStaticClient,
  createSuccessPaidResponse,
} from '../test/agent-harness.test-fixtures.js';

describe('AgentHarness local behaviors', () => {
  it('stores ready preparations with bound execution data and consumes them after execution', async () => {
    const prepared = createReadyPrepared({
      challengeDetails: {
        x402Version: 2,
        resource: {
          url: 'https://merchant.example.com/v1/generate',
          description: 'Generate a deterministic premium artifact.',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '10000',
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
                  prompt: 'hello',
                },
              },
              output: {
                type: 'json',
                example: {
                  ok: true,
                },
              },
            },
          },
        },
      },
      paymentRequirement: {
        protocol: 'x402',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        network: 'eip155:84532',
        amountType: 'exact',
        amount: '0.010000',
        amountMinor: '10000',
        precision: 6,
        provenance: {
          source: 'merchant_challenge',
          authority: 'authoritative',
        },
      },
      hints: {
        requestBodyFields: [
          {
            name: 'prompt',
            type: 'string',
            required: true,
            attribution: {
              source: 'external_metadata',
              authority: 'advisory',
            },
          },
        ],
        requestQueryParams: [
          {
            name: 'style',
            type: 'string',
            required: true,
            attribution: {
              source: 'external_metadata',
              authority: 'advisory',
            },
          },
        ],
        requestPathParams: [],
        notes: [],
      },
    });
    const executePreparedRequest = vi.fn(async () => createSuccessPaidResponse());
    const harness = new AgentHarness({
      client: createStaticClient(prepared, executePreparedRequest),
      createPreparedId: () => 'prepared-1',
      now: () => new Date('2026-03-10T00:00:00.000Z'),
    });

    const summary = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    expect(summary).toMatchObject({
      preparedId: 'prepared-1',
      state: 'active',
      kind: 'ready',
      protocol: 'x402',
      costSummary: 'Costs 0.010000 USDC on Base Sepolia (exact).',
      challengeDetails: {
        x402Version: 2,
        resource: {
          description: 'Generate a deterministic premium artifact.',
        },
      },
      nextAction: 'execute',
      validationIssues: [],
    });
    expect(
      (summary.challengeDetails?.extensions?.bazaar as {
        info?: { output?: { type?: string } };
      })?.info?.output?.type,
    ).toBe('json');

    const storedRecord = harness.getPreparedRecord('prepared-1');
    expect(storedRecord.executionBinding).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://merchant.example.com/v1/generate?style=neo',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"prompt":"hello"}',
        bodyHash:
          '8a44725210b9dcd4fefd9f0eca07b70ae45e69274a3105fb25eb426a2cf8bbf4',
        challenge: {
          protocol: 'x402',
          headers: {
            'payment-required': 'payment-required-header',
          },
        },
        merchantOrigin: 'https://merchant.example.com',
      }),
    );

    storedRecord.executionBinding.headers['x-mutated'] = 'nope';
    expect(harness.getPreparedRecord('prepared-1').executionBinding.headers).toEqual({
      'content-type': 'application/json',
    });

    const result = await harness.executePreparedRequest({
      preparedId: 'prepared-1',
      executionContext: {
        description: 'Synthetic deterministic harness run.',
      },
    });

    expect(executePreparedRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      preparedId: 'prepared-1',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'success',
      status: 200,
      merchantResponse: {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":true}',
      },
      receiptId: baseReceipt.receiptId,
      paidRequestId: baseReceipt.paidRequestId,
      paymentAttemptId: baseReceipt.paymentAttemptId,
    });

    expect(harness.getExecutionResult('prepared-1')).toEqual({
      preparedId: 'prepared-1',
      state: 'consumed',
      executionResult: result,
    });

    const duplicateExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-1',
    });
    expect(duplicateExecute).toEqual({
      preparedId: 'prepared-1',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_consumed',
      message: 'Prepared request prepared-1 has already been consumed.',
    });
    expect(harness.getExecutionResult('prepared-1')).toEqual({
      preparedId: 'prepared-1',
      state: 'consumed',
      executionResult: result,
    });
  });

  it('rejects passthrough preparations locally when execution is attempted', async () => {
    const harness = new AgentHarness({
      client: createStaticClient(createPassthroughPrepared()),
      createPreparedId: () => 'prepared-free',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/free',
      method: 'GET',
    });

    expect(prepared).toMatchObject({
      preparedId: 'prepared-free',
      kind: 'passthrough',
      costSummary: 'No payment required.',
      nextAction: 'treat_as_passthrough',
      validationIssues: [],
    });

    const rejected = await harness.executePreparedRequest({
      preparedId: 'prepared-free',
    });
    expect(rejected).toEqual({
      preparedId: 'prepared-free',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_not_ready',
      message:
        'Prepared request prepared-free is not executable because it is passthrough.',
    });
    expect(harness.getExecutionResult('prepared-free')).toEqual({
      preparedId: 'prepared-free',
      state: 'active',
      executionResult: rejected,
    });
  });

  it('supersedes older active prepared requests for the same endpoint path', async () => {
    const executePreparedRequest = vi.fn(async () => createSuccessPaidResponse());
    const harness = new AgentHarness({
      client: createStaticClient(
        [
          createReadyPrepared({
            request: {
              url: 'https://merchant.example.com/public-holidays?country=DE&year=2025',
              method: 'GET',
              headers: {},
            },
          }),
          createReadyPrepared({
            request: {
              url: 'https://merchant.example.com/public-holidays?country=DE&year=2026',
              method: 'GET',
              headers: {},
            },
          }),
        ],
        executePreparedRequest,
      ),
      createPreparedId: (() => {
        const preparedIds = ['prepared-old', 'prepared-new'];
        return () => preparedIds.shift() ?? 'unexpected-prepared-id';
      })(),
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/public-holidays?country=DE&year=2025',
      method: 'GET',
    });
    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/public-holidays?country=DE&year=2026',
      method: 'GET',
    });

    expect(harness.getPreparedRecord('prepared-old')).toMatchObject({
      preparedId: 'prepared-old',
      state: 'superseded',
      supersededByPreparedId: 'prepared-new',
    });

    const staleExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-old',
    });
    expect(staleExecute).toEqual({
      preparedId: 'prepared-old',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_superseded',
      message: 'Prepared request prepared-old was superseded by prepared-new.',
    });

    const freshExecute = await harness.executePreparedRequest({
      preparedId: 'prepared-new',
    });
    expect(executePreparedRequest).toHaveBeenCalledTimes(1);
    expect(freshExecute).toMatchObject({
      preparedId: 'prepared-new',
      harnessDisposition: 'executed',
      sdkOutcomeKind: 'success',
      status: 200,
    });
  });

  it('rejects execution for prepared requests that require revision', async () => {
    const harness = new AgentHarness({
      client: createStaticClient(
        createReadyPrepared({
          validationIssues: [
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
          ],
          nextAction: 'revise_request',
        }),
      ),
      createPreparedId: () => 'prepared-revise',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    expect(prepared.nextAction).toBe('revise_request');
    expect(prepared.validationIssues).toEqual([
      expect.objectContaining({
        location: 'body',
        field: 'style',
        code: 'missing_required_field',
        source: 'external_metadata',
        blocking: true,
      }),
    ]);

    const rejected = await harness.executePreparedRequest({
      preparedId: 'prepared-revise',
    });
    expect(rejected).toEqual({
      preparedId: 'prepared-revise',
      harnessDisposition: 'rejected',
      rejectionCode: 'prepared_request_not_executable',
      message:
        'Prepared request prepared-revise requires revise_request before execution.',
    });
    expect(harness.getExecutionResult('prepared-revise')).toEqual({
      preparedId: 'prepared-revise',
      state: 'active',
      executionResult: rejected,
    });
  });

  it('rejects missing, unknown, and expired prepared ids without calling the SDK', async () => {
    const now = new Date('2026-03-10T00:00:00.000Z');
    const executePreparedRequest = vi.fn(async () => createSuccessPaidResponse());
    const harness = new AgentHarness({
      client: createStaticClient(createReadyPrepared(), executePreparedRequest),
      createPreparedId: () => 'prepared-expiring',
      preparedTtlMs: 1_000,
      now: () => now,
    });

    expect(
      await harness.executePreparedRequest({
        preparedId: '',
      }),
    ).toEqual({
      preparedId: '',
      harnessDisposition: 'rejected',
      rejectionCode: 'missing_prepared_id',
      message: 'A preparedId is required.',
    });

    expect(
      await harness.executePreparedRequest({
        preparedId: 'prepared-unknown',
      }),
    ).toEqual({
      preparedId: 'prepared-unknown',
      harnessDisposition: 'rejected',
      rejectionCode: 'unknown_prepared_id',
      message: 'Prepared request prepared-unknown is unknown.',
    });

    await harness.preparePaidRequest({
      url: 'https://merchant.example.com/v1/generate?style=neo',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    now.setTime(new Date('2026-03-10T00:00:02.000Z').getTime());

    const expired = await harness.executePreparedRequest({
      preparedId: 'prepared-expiring',
    });
    expect(expired).toEqual({
      preparedId: 'prepared-expiring',
      harnessDisposition: 'rejected',
      rejectionCode: 'expired_prepared_id',
      message: 'Prepared request prepared-expiring has expired.',
    });
    expect(harness.getPreparedRecord('prepared-expiring').state).toBe('expired');
    expect(harness.getExecutionResult('prepared-expiring')).toEqual({
      preparedId: 'prepared-expiring',
      state: 'expired',
      executionResult: expired,
    });
    expect(executePreparedRequest).not.toHaveBeenCalled();
  });

  it('builds a human-readable Solana cost summary from challenge metadata', async () => {
    const harness = new AgentHarness({
      client: createStaticClient(
        createReadyPrepared({
          request: {
            url: 'https://merchant.example.com/solana-report',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: '{"topic":"solana receipts"}',
          },
          challengeDetails: {
            x402Version: 2,
            accepts: [
              {
                network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                amount: '1000',
                extra: {
                  name: 'USD Coin',
                },
              },
            ],
          },
          paymentRequirement: {
            protocol: 'x402',
            asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            amountType: 'exact',
            amount: '0.001000',
            amountMinor: '1000',
            precision: 6,
            provenance: {
              source: 'merchant_challenge',
              authority: 'authoritative',
            },
          },
        }),
      ),
      createPreparedId: () => 'prepared-solana',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/solana-report',
      method: 'POST',
      body: '{"topic":"solana receipts"}',
    });

    expect(prepared.costSummary).toBe(
      'Costs 0.001000 USD Coin on Solana (exact).',
    );
  });

  it('formats fallback cost summaries from raw asset and network values', async () => {
    const harness = new AgentHarness({
      client: createStaticClient(
        createReadyPrepared({
          request: {
            url: 'https://merchant.example.com/custom-report',
            method: 'POST',
            headers: {},
          },
          challengeDetails: {
            accepts: [
              {
                network: 'custom-net',
                asset: 'mystery-asset',
              },
            ],
          },
          paymentRequirement: {
            protocol: 'x402',
            asset: 'mystery-asset',
            network: 'custom-net',
            amountType: 'max',
            amountMinor: '2500',
            precision: 3,
            provenance: {
              source: 'merchant_challenge',
              authority: 'authoritative',
            },
          },
        }),
      ),
      createPreparedId: () => 'prepared-custom',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/custom-report',
      method: 'POST',
    });

    expect(prepared.costSummary).toBe(
      'Costs 2.500 mystery-asset on custom-net (up to).',
    );
  });

  it('formats cost summaries from known stablecoin metadata when precision is omitted', async () => {
    const harness = new AgentHarness({
      client: createStaticClient(
        createReadyPrepared({
          request: {
            url: 'https://merchant.example.com/compat-joke',
            method: 'POST',
            headers: {},
          },
          challengeDetails: {
            accepts: [
              {
                network: 'base-sepolia',
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                extra: {
                  name: 'USDC',
                },
              },
            ],
          },
          paymentRequirement: {
            protocol: 'x402',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            network: 'base-sepolia',
            amountType: 'max',
            amountMinor: '5000',
            provenance: {
              source: 'merchant_challenge',
              authority: 'authoritative',
            },
          },
        }),
      ),
      createPreparedId: () => 'prepared-known-precision',
    });

    const prepared = await harness.preparePaidRequest({
      url: 'https://merchant.example.com/compat-joke',
      method: 'POST',
    });

    expect(prepared.costSummary).toBe(
      'Costs 0.005000 USDC on Base Sepolia (up to).',
    );
  });
});