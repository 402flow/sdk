#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadOpenAiHarnessScenario } from '../examples/openai-harness/inputs.mjs';
import {
  createScenarioArtifactPaths,
  scenarioRunsDir,
  summaryPath,
  tmpDir,
} from '../examples/openai-harness/transcript-paths.mjs';

const sdkRoot = resolve(import.meta.dirname ?? '.', '..');

const firstPartyScenarioPlan = [
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
];

const thirdPartyScenarioPlan = [
  ['nickeljoke-compat', 'ready-json-post'],
  ['auor-public-holidays-reasoning-revise', 'revise-get-query'],
  ['x402-org-protected-ready', 'ready-json-post'],
];

const mockScenarioPlan = [
  ['policy-denied-budget-exceeded', 'mock-governance'],
  ['policy-denied-merchant-not-allowed', 'mock-governance'],
  ['policy-blocked-review-event', 'mock-governance'],
  ['execution-failed-merchant-rejected', 'mock-governance'],
  ['execution-inconclusive', 'mock-governance'],
  ['preflight-failed-no-rail', 'mock-governance'],
];

function parsePlanName(argv) {
  const option = argv.find((arg) => arg.startsWith('--plan='));

  if (!option) {
    return 'first-party';
  }

  const planName = option.split('=')[1]?.trim();

  if (!planName) {
    return 'first-party';
  }

  return planName;
}

function buildScenarioPlan(planName) {
  if (planName === 'first-party') {
    return firstPartyScenarioPlan;
  }

  if (planName === 'core') {
    return [
      ...firstPartyScenarioPlan,
      ...mockScenarioPlan,
    ];
  }

  if (planName === 'third-party') {
    return thirdPartyScenarioPlan;
  }

  if (planName === 'mock') {
    return mockScenarioPlan;
  }

  if (planName === 'all') {
    return [
      ...firstPartyScenarioPlan,
      ...thirdPartyScenarioPlan,
      ...mockScenarioPlan,
    ];
  }

  process.stderr.write(
    `Unsupported scenario plan: ${planName}. Use first-party, core, third-party, mock, or all.\n`,
  );
  process.exit(1);
}

function loadScenarioDefinition(scenarioName) {
  return loadOpenAiHarnessScenario(
    resolve(sdkRoot, 'examples', 'scenarios', `${scenarioName}.json`),
  );
}

function runHarnessScenario({ scenario, preset, transcriptPath, campaignId }) {
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
        env: {
          ...process.env,
          X402FLOW_CORE_CAMPAIGN_ID: campaignId ?? '',
        },
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
      && toolCall?.result?.executionResult?.preparedId === toolCalls[executeIndex]?.result?.preparedId
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
  const executions = toolCalls.filter((call) => call?.name === 'execute_prepared_request');
  if (executions.length !== 1 || !isDeepStrictEqual(executions[0].result, executionResult)) {
    return createSemanticFailure(
      'Scenario must record one execution and an identical stored execution result.',
      transcript,
    );
  }

  if (executionResult?.sdkOutcomeKind !== expectedOutcomeKind) {
    return createSemanticFailure(
      `Scenario expected sdkOutcomeKind ${expectedOutcomeKind} but observed ${executionResult?.sdkOutcomeKind ?? 'none'}.`,
      transcript,
    );
  }
  if (expectedOutcomeKind === 'success' && (executionResult.status !== 200
    || typeof executionResult.receiptId !== 'string' || !executionResult.receiptId
    || typeof executionResult.paidRequestId !== 'string' || !executionResult.paidRequestId)) {
    return createSemanticFailure('Successful scenario requires HTTP 200, receiptId, and paidRequestId.', transcript);
  }

  const finalText =
    typeof transcript.finalText === 'string' ? transcript.finalText : '';

  if (expectedOutcomeKind !== 'success') {
    const lowerFinalText = finalText.toLowerCase();
    const reportsNonSuccessOutcome = [
      'outcome: denied',
      'outcome: execution_failed',
      'outcome: execution failed',
      'outcome: execution_inconclusive',
      'outcome: execution inconclusive',
      'outcome: execution_pending',
      'outcome: execution pending',
      'outcome: preflight_failed',
      'outcome: preflight failed',
      'outcome: paid_fulfillment_failed',
      'outcome: paid fulfillment failed',
      'outcome: request_failed',
      'outcome: request failed',
      'status: 4',
      'status: 5',
      'merchant outcome: deny',
    ].some((phrase) => lowerFinalText.includes(phrase));
    const looksLikeSuccessClaim = [
      'executed successfully',
      'outcome: `success`',
      'outcome: success',
      'successful via 402flow',
    ].some((phrase) => lowerFinalText.includes(phrase));

    if (looksLikeSuccessClaim && !reportsNonSuccessOutcome) {
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

export { buildScenarioPlan, extractSemanticOutcome, loadScenarioDefinition };

function runScenarioPlan() {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(scenarioRunsDir, { recursive: true });

  const selectedPlan = parsePlanName(process.argv.slice(2));
  const scenarioPlan = buildScenarioPlan(selectedPlan);
  const campaignId = selectedPlan === 'core' ? randomUUID() : undefined;

  const summaryLines = [];
  let hadFailure = false;

  summaryLines.push(`Scenario plan: ${selectedPlan}`);
  if (campaignId) summaryLines.push(`Campaign ID: ${campaignId}`);
  summaryLines.push('');

  for (const [scenario, preset] of scenarioPlan) {
    const scenarioDefinition = loadScenarioDefinition(scenario);
    const { transcriptPath, logPath } = createScenarioArtifactPaths(scenario);
    const result = runHarnessScenario({ scenario, preset, transcriptPath, campaignId });

    writeFileSync(logPath, result.output, 'utf8');

    summaryLines.push(`=== ${scenario} (${preset}) ===`);

    if (result.exitCode !== 0) {
      hadFailure = true;
      summaryLines.push(`FAIL exit=${result.exitCode}`);
      summaryLines.push(result.output.trim() || 'Harness process exited without output.');
      summaryLines.push('');
      break;
    }

    let transcript;

    try {
      transcript = readTranscript(transcriptPath);
    } catch (error) {
      hadFailure = true;
      summaryLines.push('FAIL transcript_missing');
      summaryLines.push(error instanceof Error ? error.message : String(error));
      summaryLines.push('');
      break;
    }

    const semanticOutcome = extractSemanticOutcome(transcript, scenarioDefinition);

    if (!semanticOutcome.ok) {
      hadFailure = true;
      summaryLines.push('FAIL semantic');
      summaryLines.push(
        formatFailure(result.output, transcript, semanticOutcome.finalText),
      );
      summaryLines.push('');
      break;
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
    writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');
    process.stdout.write(`PASS ${scenario}\n`);
  }

  writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

  if (hadFailure) {
    process.stderr.write(
      `Scenario run failed for plan ${selectedPlan}. See ${summaryPath}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `Scenario run passed for plan ${selectedPlan}. Results written to ${summaryPath}\n`,
  );
}

// Importing the evaluator for offline evidence review never runs a scenario.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runScenarioPlan();
}
