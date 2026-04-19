#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  createScenarioArtifactPaths,
  scenarioRunsDir,
  summaryPath,
  tmpDir,
} from '../examples/openai-harness/transcript-paths.mjs';

const sdkRoot = resolve(import.meta.dirname ?? '.', '..');

const scenarioPlan = [
  ['nickeljoke-compat', 'ready-json-post'],
  ['auor-public-holidays-reasoning-revise', 'revise-get-query'],
  ['base-sepolia-research-brief-bazaar-revise', 'revise-json-post'],
  ['base-sepolia-research-brief-ready', 'ready-json-post'],
  ['base-sepolia-research-brief-revise', 'revise-json-post'],
  ['base-mainnet-research-brief-bazaar-revise', 'revise-json-post'],
  ['base-mainnet-research-brief-ready', 'ready-json-post'],
  ['base-mainnet-research-brief-revise', 'revise-json-post'],
  ['solana-devnet-research-brief-bazaar-revise', 'revise-json-post'],
  ['solana-devnet-research-brief-ready', 'ready-json-post'],
  ['solana-devnet-research-brief-revise', 'revise-json-post'],
  ['solana-mainnet-research-brief-bazaar-revise', 'revise-json-post'],
  ['solana-mainnet-research-brief-ready', 'ready-json-post'],
  ['solana-mainnet-research-brief-revise', 'revise-json-post'],
  ['x402-org-protected-ready', 'ready-json-post'],
];

function runHarnessScenario({ scenario, preset, transcriptPath }) {
  try {
    const stdout = execFileSync(
      'node',
      [
        'examples/openai-agent-harness.mjs',
        '--preset',
        preset,
        '--scenario',
        scenario,
        '--transcript-file',
        transcriptPath,
      ],
      {
        cwd: sdkRoot,
        encoding: 'utf8',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    return {
      exitCode: 0,
      output: stdout,
    };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

function readTranscript(transcriptPath) {
  return JSON.parse(readFileSync(transcriptPath, 'utf8'));
}

function extractSemanticOutcome(transcript) {
  const toolCalls = Array.isArray(transcript.toolCalls) ? transcript.toolCalls : [];

  for (const toolCall of toolCalls) {
    const executionResult = toolCall?.result?.executionResult;

    if (
      executionResult?.harnessDisposition === 'executed'
      && executionResult?.sdkOutcomeKind === 'success'
    ) {
      return {
        ok: true,
        status: executionResult.status,
        receiptId: executionResult.receiptId,
        paidRequestId: executionResult.paidRequestId,
      };
    }
  }

  for (const toolCall of toolCalls) {
    if (
      toolCall?.result?.harnessDisposition === 'executed'
      && toolCall?.result?.sdkOutcomeKind === 'success'
    ) {
      return {
        ok: true,
        status: toolCall.result.status,
        receiptId: toolCall.result.receiptId,
        paidRequestId: toolCall.result.paidRequestId,
      };
    }
  }

  return {
    ok: false,
    finalText:
      typeof transcript.finalText === 'string'
        ? transcript.finalText
        : 'Scenario did not record a successful execution result.',
  };
}

function formatFailure(output, transcript) {
  const finalText = typeof transcript?.finalText === 'string' ? transcript.finalText : undefined;
  const outputTail = output.trim().split('\n').slice(-40).join('\n').trim();

  return [finalText, outputTail].filter(Boolean).join('\n\n');
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(scenarioRunsDir, { recursive: true });

const summaryLines = [];
let hadFailure = false;

for (const [scenario, preset] of scenarioPlan) {
  const { transcriptPath, logPath } = createScenarioArtifactPaths(scenario);
  const result = runHarnessScenario({ scenario, preset, transcriptPath });

  writeFileSync(logPath, result.output, 'utf8');

  summaryLines.push(`=== ${scenario} (${preset}) ===`);

  if (result.exitCode !== 0) {
    hadFailure = true;
    summaryLines.push(`FAIL exit=${result.exitCode}`);
    summaryLines.push(result.output.trim() || 'Harness process exited without output.');
    summaryLines.push('');
    continue;
  }

  let transcript;

  try {
    transcript = readTranscript(transcriptPath);
  } catch (error) {
    hadFailure = true;
    summaryLines.push('FAIL transcript_missing');
    summaryLines.push(error instanceof Error ? error.message : String(error));
    summaryLines.push('');
    continue;
  }

  const semanticOutcome = extractSemanticOutcome(transcript);

  if (!semanticOutcome.ok) {
    hadFailure = true;
    summaryLines.push('FAIL semantic');
    summaryLines.push(formatFailure(result.output, transcript));
    summaryLines.push('');
    continue;
  }

  summaryLines.push('PASS');
  summaryLines.push(`status=${semanticOutcome.status}`);
  if (semanticOutcome.receiptId) {
    summaryLines.push(`receiptId=${semanticOutcome.receiptId}`);
  }
  if (semanticOutcome.paidRequestId) {
    summaryLines.push(`paidRequestId=${semanticOutcome.paidRequestId}`);
  }
  summaryLines.push('');
}

writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

if (hadFailure) {
  process.stderr.write(`Scenario run failed. See ${summaryPath}\n`);
  process.exit(1);
}

process.stdout.write(`Scenario run passed. Results written to ${summaryPath}\n`);