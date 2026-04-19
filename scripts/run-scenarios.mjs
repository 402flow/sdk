#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { loadOpenAiHarnessScenario } from '../examples/openai-harness/inputs.mjs';
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
  ['policy-denied-budget-exceeded', 'mock-governance'],
  ['policy-denied-merchant-not-allowed', 'mock-governance'],
  ['policy-blocked-review-event', 'mock-governance'],
  ['execution-failed-merchant-rejected', 'mock-governance'],
  ['execution-inconclusive', 'mock-governance'],
  ['preflight-failed-no-rail', 'mock-governance'],
];

function loadScenarioDefinition(scenarioName) {
  return loadOpenAiHarnessScenario(
    resolve(sdkRoot, 'examples', 'scenarios', `${scenarioName}.json`),
  );
}

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

function createSemanticFailure(message, transcript) {
  return {
    ok: false,
    finalText:
      typeof transcript?.finalText === 'string'
        ? `${message}\n\n${transcript.finalText}`
        : message,
  };
}

function validatePreparationSummaries(toolCalls, transcript) {
  const prepareCalls = toolCalls.filter(
    (toolCall) => toolCall?.name === 'prepare_paid_request',
  );

  if (prepareCalls.length === 0) {
    return createSemanticFailure(
      'Scenario did not record any prepare_paid_request tool calls.',
      transcript,
    );
  }

  for (const toolCall of prepareCalls) {
    const result = toolCall?.result;

    if (
      result
      && typeof result === 'object'
      && 'kind' in result
      && (typeof result.costSummary !== 'string' || result.costSummary.trim().length === 0)
    ) {
      return createSemanticFailure(
        'Scenario prepare result was missing costSummary.',
        transcript,
      );
    }
  }

  return null;
}

function findExecutionLookup(toolCalls) {
  const executeIndex = toolCalls.findIndex(
    (toolCall) => toolCall?.name === 'execute_prepared_request',
  );

  if (executeIndex === -1) {
    return undefined;
  }

  return toolCalls.find(
    (toolCall, index) =>
      index > executeIndex
      && toolCall?.name === 'get_execution_result'
      && toolCall?.result?.executionResult?.harnessDisposition === 'executed',
  );
}

function extractSemanticOutcome(transcript, scenarioDefinition) {
  const toolCalls = Array.isArray(transcript.toolCalls) ? transcript.toolCalls : [];
  const preparationFailure = validatePreparationSummaries(toolCalls, transcript);

  if (preparationFailure) {
    return preparationFailure;
  }

  const expectedOutcomeKind = scenarioDefinition.expectedOutcomeKind ?? 'success';
  const executionLookup = findExecutionLookup(toolCalls);

  if (!executionLookup) {
    return createSemanticFailure(
      'Scenario did not call get_execution_result after execution.',
      transcript,
    );
  }

  const executionResult = executionLookup.result.executionResult;

  if (executionResult?.sdkOutcomeKind !== expectedOutcomeKind) {
    return createSemanticFailure(
      `Scenario expected sdkOutcomeKind ${expectedOutcomeKind} but observed ${executionResult?.sdkOutcomeKind ?? 'none'}.`,
      transcript,
    );
  }

  const finalText =
    typeof transcript.finalText === 'string' ? transcript.finalText : '';

  if (expectedOutcomeKind !== 'success') {
    const lowerFinalText = finalText.toLowerCase();
    const looksLikeSuccessClaim = [
      'executed successfully',
      'outcome: `success`',
      'outcome: success',
      'successful via 402flow',
    ].some((phrase) => lowerFinalText.includes(phrase));

    if (looksLikeSuccessClaim) {
      return createSemanticFailure(
        'Scenario final text claimed success for a non-success outcome.',
        transcript,
      );
    }

    for (const snippet of scenarioDefinition.expectedFinalTextIncludes ?? []) {
      if (!lowerFinalText.includes(snippet.toLowerCase())) {
        return createSemanticFailure(
          `Scenario final text did not include expected snippet: ${snippet}`,
          transcript,
        );
      }
    }
  }

  return {
    ok: true,
    outcomeKind: executionResult.sdkOutcomeKind,
    status: executionResult.status,
    receiptId: executionResult.receiptId,
    paidRequestId: executionResult.paidRequestId,
  };
}

function formatFailure(output, transcript, semanticFailureText) {
  const finalText = semanticFailureText
    ?? (typeof transcript?.finalText === 'string' ? transcript.finalText : undefined);
  const outputTail = output.trim().split('\n').slice(-40).join('\n').trim();

  return [finalText, outputTail].filter(Boolean).join('\n\n');
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(scenarioRunsDir, { recursive: true });

const summaryLines = [];
let hadFailure = false;

for (const [scenario, preset] of scenarioPlan) {
  const scenarioDefinition = loadScenarioDefinition(scenario);
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

  const semanticOutcome = extractSemanticOutcome(transcript, scenarioDefinition);

  if (!semanticOutcome.ok) {
    hadFailure = true;
    summaryLines.push('FAIL semantic');
    summaryLines.push(
      formatFailure(result.output, transcript, semanticOutcome.finalText),
    );
    summaryLines.push('');
    continue;
  }

  summaryLines.push('PASS');
  summaryLines.push(`sdkOutcomeKind=${semanticOutcome.outcomeKind}`);
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