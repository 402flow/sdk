import { describe, expect, it, vi } from 'vitest';

import { createToolHandlers } from './openai-tools-runtime.mjs';

describe('openai tools runtime prepare handler', () => {
  it('passes well-formed prepare arguments through unchanged', async () => {
    const preparePaidRequest = vi.fn(async (args) => args);
    const handlers = createToolHandlers({
      preparePaidRequest,
      executePreparedRequest: vi.fn(),
      getExecutionResult: vi.fn(),
    });

    const result = await handlers.prepare_paid_request({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"topic":"solana-devnet receipt promotion"}',
      externalMetadata: {
        requestBodyType: 'json',
      },
    });

    expect(preparePaidRequest).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"topic":"solana-devnet receipt promotion"}',
      externalMetadata: {
        requestBodyType: 'json',
      },
    });
    expect(result).toEqual({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"topic":"solana-devnet receipt promotion"}',
      externalMetadata: {
        requestBodyType: 'json',
      },
    });
  });

  it('recovers headers, body, and external metadata nested inside the body string', async () => {
    const preparePaidRequest = vi.fn(async (args) => args);
    const handlers = createToolHandlers({
      preparePaidRequest,
      executePreparedRequest: vi.fn(),
      getExecutionResult: vi.fn(),
    });

    const result = await handlers.prepare_paid_request({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      body: JSON.stringify({
        headers: {
          'content-type': 'application/json',
        },
        body: {
          topic: 'solana-devnet receipt promotion',
          audience: 'sdk integrator',
          format: 'bullets',
        },
        externalMetadata: {
          requestBodyType: 'json',
          requestBodyExample:
            '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
        },
      }),
    });

    expect(preparePaidRequest).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body:
        '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
      externalMetadata: {
        requestBodyType: 'json',
        requestBodyExample:
          '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
      },
    });
    expect(result).toEqual({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body:
        '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
      externalMetadata: {
        requestBodyType: 'json',
        requestBodyExample:
          '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
      },
    });
  });

  it('adds application/json when the model omits headers for a JSON body', async () => {
    const preparePaidRequest = vi.fn(async (args) => args);
    const handlers = createToolHandlers({
      preparePaidRequest,
      executePreparedRequest: vi.fn(),
      getExecutionResult: vi.fn(),
    });

    const result = await handlers.prepare_paid_request({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      body:
        '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
    });

    expect(preparePaidRequest).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body:
        '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
    });
    expect(result).toEqual({
      url: 'http://127.0.0.1:4123/paid/solana-devnet/research-brief',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body:
        '{"topic":"solana-devnet receipt promotion","audience":"sdk integrator","format":"bullets"}',
    });
  });
});