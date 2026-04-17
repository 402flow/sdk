import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadJsonPromptValue,
  loadOpenAiHarnessScenario,
} from './inputs.mjs';

describe('openai agent harness input helpers', () => {
  it('loads and normalizes inline JSON, file JSON, and defaults', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'sdk-harness-inputs-'));
    const fixturePath = join(tempDirectory, 'payload.json');
    writeFileSync(fixturePath, '{"prompt":"foggy coastline","style":"photo"}');

    expect(
      loadJsonPromptValue({
        label: 'body',
        inlineValue: '{"prompt":"foggy coastline"}',
      }),
    ).toBe('{"prompt":"foggy coastline"}');

    expect(
      loadJsonPromptValue({
        label: 'body',
        filePath: fixturePath,
      }),
    ).toBe('{"prompt":"foggy coastline","style":"photo"}');

    expect(
      loadJsonPromptValue({
        label: 'headers',
        defaultValue: '{"content-type":"application/json"}',
      }),
    ).toBe('{"content-type":"application/json"}');
  });

  it('rejects ambiguous, invalid, and missing required JSON inputs', () => {
    expect(() =>
      loadJsonPromptValue({
        label: 'body',
        inlineValue: '{}',
        filePath: './payload.json',
      }),
    ).toThrow('body cannot be provided as both inline JSON and a file path.');

    expect(() =>
      loadJsonPromptValue({
        label: 'discovery metadata',
        inlineValue: '{bad json}',
      }),
    ).toThrow('discovery metadata must contain valid JSON.');

    expect(() =>
      loadJsonPromptValue({
        label: 'discovery metadata',
        required: true,
      }),
    ).toThrow(
      'Missing required discovery metadata. Provide inline JSON or a JSON file path.',
    );
  });

  it('loads a scenario file and validates its shape', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'sdk-harness-scenario-'));
    const fixturePath = join(tempDirectory, 'scenario.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        name: 'nickeljoke-compat',
        description: 'Ready public compatibility scenario.',
        targetUrl: 'https://nickeljoke.vercel.app/api/joke',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: {
          topic: 'sdk integration',
          tone: 'dry',
          audience: 'platform engineers',
        },
      }),
    );

    expect(loadOpenAiHarnessScenario(fixturePath)).toEqual({
      name: 'nickeljoke-compat',
      description: 'Ready public compatibility scenario.',
      targetUrl: 'https://nickeljoke.vercel.app/api/joke',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        topic: 'sdk integration',
        tone: 'dry',
        audience: 'platform engineers',
      },
    });
  });

  it('allows scenarios to omit optional headers, body, and discovery metadata', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'sdk-harness-scenario-min-'));
    const fixturePath = join(tempDirectory, 'scenario.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        name: 'nickeljoke-compat',
        description: 'Real public compatibility merchant.',
        targetUrl: 'https://nickeljoke.vercel.app/api/joke',
        method: 'POST',
      }),
    );

    expect(loadOpenAiHarnessScenario(fixturePath)).toEqual({
      name: 'nickeljoke-compat',
      description: 'Real public compatibility merchant.',
      targetUrl: 'https://nickeljoke.vercel.app/api/joke',
      method: 'POST',
    });
  });
});