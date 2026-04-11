import { describe, expect, it } from 'vitest';

import {
  appendOpenAiHarnessToolCall,
  createOpenAiHarnessTranscript,
  finalizeOpenAiHarnessTranscript,
  serializeOpenAiHarnessTranscript,
} from './transcript.mjs';

describe('openai agent harness transcript helpers', () => {
  it('builds, appends, finalizes, and serializes a deterministic transcript', () => {
    const started = '2026-04-10T10:00:00.000Z';
    const completed = '2026-04-10T10:00:05.000Z';

    const transcript = createOpenAiHarnessTranscript({
      startedAt: started,
      preset: 'ready-json-post',
      scenario: 'image-ready',
      model: 'gpt-5.4',
      prompt: 'Prepare and execute the request.',
      maxTurns: 8,
      preparedTtlMs: 300_000,
      instructions: 'Always prepare first.',
    });

    const withToolCall = appendOpenAiHarnessToolCall(transcript, {
      turn: 1,
      responseId: 'resp_123',
      callId: 'call_123',
      name: 'prepare_paid_request',
      rawArguments: '{"url":"https://merchant.example.com"}',
      parsedArguments: {
        url: 'https://merchant.example.com',
      },
      result: {
        preparedId: 'prepared-1',
        nextAction: 'execute',
      },
    });

    const finalized = finalizeOpenAiHarnessTranscript(withToolCall, {
      completedAt: completed,
      finalResponseId: 'resp_final',
      finalText: 'Prepared and executed successfully.',
    });

    expect(transcript.toolCalls).toEqual([]);
    expect(finalized).toEqual({
      startedAt: started,
      completedAt: completed,
      preset: 'ready-json-post',
      scenario: 'image-ready',
      model: 'gpt-5.4',
      prompt: 'Prepare and execute the request.',
      maxTurns: 8,
      preparedTtlMs: 300_000,
      instructions: 'Always prepare first.',
      finalResponseId: 'resp_final',
      finalText: 'Prepared and executed successfully.',
      toolCalls: [
        {
          turn: 1,
          responseId: 'resp_123',
          callId: 'call_123',
          name: 'prepare_paid_request',
          rawArguments: '{"url":"https://merchant.example.com"}',
          parsedArguments: {
            url: 'https://merchant.example.com',
          },
          result: {
            preparedId: 'prepared-1',
            nextAction: 'execute',
          },
        },
      ],
    });

    expect(serializeOpenAiHarnessTranscript(finalized)).toBe(
      JSON.stringify(finalized, null, 2),
    );
  });
});