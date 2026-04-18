#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AgentHarness } from '../dist/index.js';
import {
  appendOpenAiHarnessToolCall,
  createOpenAiHarnessTranscript,
  finalizeOpenAiHarnessTranscript,
  serializeOpenAiHarnessTranscript,
} from './openai-harness/transcript.mjs';
import {
  loadJsonPromptValue,
  loadOpenAiHarnessScenario,
} from './openai-harness/inputs.mjs';
import { defaultTranscriptFileForScenario } from './openai-harness/transcript-paths.mjs';
import {
  createClientFromEnv,
  createOpenAiClient,
  createToolHandlers,
  defaultInstructions,
  defaultMaxTurns,
  defaultModel,
  getRequiredEnv,
  runOpenAiToolsSession,
} from './openai-tools-runtime.mjs';

const defaultPreparedTtlMs = 5 * 60 * 1000;

const scenarioCatalog = {
  'nickeljoke-compat': './examples/scenarios/nickeljoke-compat.json',
  'auor-public-holidays-reasoning-revise': './examples/scenarios/auor-public-holidays-reasoning-revise.json',
  'solana-devnet-research-brief-bazaar-revise': './examples/scenarios/solana-devnet-research-brief-bazaar-revise.json',
  'solana-devnet-research-brief-ready': './examples/scenarios/solana-devnet-research-brief-ready.json',
  'solana-devnet-research-brief-revise': './examples/scenarios/solana-devnet-research-brief-revise.json',
  'solana-mainnet-research-brief-bazaar-revise': './examples/scenarios/solana-mainnet-research-brief-bazaar-revise.json',
  'solana-mainnet-research-brief-ready': './examples/scenarios/solana-mainnet-research-brief-ready.json',
  'solana-mainnet-research-brief-revise': './examples/scenarios/solana-mainnet-research-brief-revise.json',
  'x402-org-protected-ready': './examples/scenarios/x402-org-protected-ready.json',
};

function stringifyDefaultJson(value) {
  return value === undefined ? undefined : JSON.stringify(value);
}

function buildPromptRequestLines({ method, url, headers, body, externalMetadata }) {
  return [
    `Use ${method} ${url}.`,
    ...(headers ? [`Use headers ${headers}.`] : []),
    ...(body ? [`Use body ${body}.`] : []),
    ...(externalMetadata
      ? [`Use this externalMetadata during preparation: ${externalMetadata}.`]
      : []),
  ];
}

function resolveScenario(args) {
  const scenarioName = args.scenario ?? process.env.AGENT_HARNESS_SCENARIO;

  if (!scenarioName) {
    return undefined;
  }

  const scenarioPath = scenarioCatalog[scenarioName];
  if (!scenarioPath) {
    throw new Error(`Unknown scenario: ${scenarioName}`);
  }

  return loadOpenAiHarnessScenario(scenarioPath);
}

const promptPresets = {
  'ready-json-post': {
    description:
      'Prepare a JSON POST request, execute only when ready, and otherwise stop cleanly on passthrough or missing required business inputs.',
    buildPrompt(context) {
      const url =
        process.env.AGENT_HARNESS_TARGET_URL ??
        context.scenario?.targetUrl ??
        getRequiredEnv('AGENT_HARNESS_TARGET_URL');
      const method = context.scenario?.method ?? 'POST';
      const headers = loadJsonPromptValue({
        label: 'headers',
        inlineValue: process.env.AGENT_HARNESS_HEADERS_JSON,
        filePath: process.env.AGENT_HARNESS_HEADERS_FILE,
        defaultValue: context.scenario
          ? stringifyDefaultJson(context.scenario.headers)
          : '{"content-type":"application/json"}',
      });
      const body = loadJsonPromptValue({
        label: 'body',
        inlineValue: process.env.AGENT_HARNESS_BODY_JSON,
        filePath: process.env.AGENT_HARNESS_BODY_FILE,
        defaultValue: context.scenario
          ? stringifyDefaultJson(context.scenario.body)
          : '{"prompt":"foggy coastline"}',
      });
      const externalMetadata = loadJsonPromptValue({
        label: 'external metadata',
        inlineValue: process.env.AGENT_HARNESS_EXTERNAL_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_EXTERNAL_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.externalMetadata),
      });

      return [
        'Prepare and execute a paid HTTP request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          externalMetadata,
        }),
        !externalMetadata
          ? 'Do not invent externalMetadata beyond what is explicitly provided.'
          : undefined,
        'Treat externalMetadata as advisory when merchant challenge hints disagree.',
        'Inspect challengeDetails when present for merchant resource metadata and extension-published discovery data before deciding whether to revise or execute.',
        'If preparation returns nextAction as treat_as_passthrough, do not pay and explain that paid execution is not required.',
        'If preparation returns nextAction as revise_request, revise only when the task provides enough information; otherwise stop and explain what is still missing.',
        'Execute only if preparation returns nextAction as execute.',
        'After execution, call get_execution_result and summarize the stored result.',
      ]
        .filter(Boolean)
        .join(' ');
    },
  },
  'revise-json-post': {
    description:
      'Prepare a JSON POST request, revise once when the task provides enough information, and otherwise stop cleanly on passthrough or missing inputs.',
    buildPrompt(context) {
      const url =
        process.env.AGENT_HARNESS_TARGET_URL ??
        context.scenario?.targetUrl ??
        getRequiredEnv('AGENT_HARNESS_TARGET_URL');
      const method = context.scenario?.method ?? 'POST';
      const headers = loadJsonPromptValue({
        label: 'headers',
        inlineValue: process.env.AGENT_HARNESS_HEADERS_JSON,
        filePath: process.env.AGENT_HARNESS_HEADERS_FILE,
        defaultValue:
          stringifyDefaultJson(context.scenario?.headers) ??
          '{"content-type":"application/json"}',
      });
      const body = loadJsonPromptValue({
        label: 'body',
        inlineValue: process.env.AGENT_HARNESS_BODY_JSON,
        filePath: process.env.AGENT_HARNESS_BODY_FILE,
        defaultValue:
          stringifyDefaultJson(context.scenario?.body) ??
          '{"prompt":"foggy coastline"}',
      });
      const externalMetadata = loadJsonPromptValue({
        label: 'external metadata',
        inlineValue: process.env.AGENT_HARNESS_EXTERNAL_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_EXTERNAL_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.externalMetadata),
      });

      return [
        'Prepare a paid HTTP request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          externalMetadata,
        }),
        'Treat externalMetadata as advisory when merchant challenge hints disagree.',
        'Inspect challengeDetails when present for merchant resource metadata and extension-published discovery data before deciding whether to revise or execute.',
        'If preparation returns nextAction as treat_as_passthrough, do not pay and explain that paid execution is not required.',
        'If preparation returns nextAction as revise_request, revise the request once using validationIssues, hints, and challengeDetails.extensions when present only when the task provides enough information; otherwise stop and explain what is still missing.',
        'If preparation returns nextAction as execute but hints still describe missing required body fields, revise once using hints.requestBodyExample (or externalMetadata.requestBodyExample when provided) only when the task provides enough information; otherwise stop and explain what is still missing.',
        'Do not execute the same prepared request twice unless the caller explicitly asks for a retry.',
        'After execution, call get_execution_result and summarize the stored result.',
      ].join(' ');
    },
  },
  'revise-get-query': {
    description:
      'Send a GET request, derive missing query params when the task provides enough information, and otherwise stop cleanly on passthrough or missing inputs.',
    buildPrompt(context) {
      const url =
        process.env.AGENT_HARNESS_TARGET_URL ??
        context.scenario?.targetUrl ??
        getRequiredEnv('AGENT_HARNESS_TARGET_URL');
      const task = context.scenario?.task ?? process.env.AGENT_HARNESS_TASK;
      const externalMetadata = loadJsonPromptValue({
        label: 'external metadata',
        inlineValue: process.env.AGENT_HARNESS_EXTERNAL_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_EXTERNAL_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.externalMetadata),
      });

      return [
        task ?? 'Fetch data from a paid API.',
        `Use the Auor-compatible endpoint at ${url}.`,
        'First, call prepare_paid_request with method GET and the bare URL (no query params).',
        'If preparation returns nextAction as treat_as_passthrough, do not pay and explain that paid execution is not required.',
        'If preparation returns nextAction as revise_request, inspect validationIssues, hints.requestQueryParams, and challengeDetails.extensions when present to determine what query parameters are required.',
        'Reason about the correct values for each required parameter based on the task above only when the task provides enough information; otherwise stop and explain what is still missing.',
        'If you do revise the URL, call prepare_paid_request again with those query params appended to the URL.',
        'Execute only after the revised preparation returns nextAction as execute.',
        'After execution, call get_execution_result and summarize the stored result.',
        !externalMetadata
          ? 'Do not invent externalMetadata — all hints come from the merchant challenge.'
          : 'Treat externalMetadata as advisory when merchant challenge hints disagree.',
      ]
        .filter(Boolean)
        .join(' ');
    },
  },
  'inspect-only': {
    description:
      'Prepare a candidate request and stop after explaining nextAction, passthrough behavior, or missing inputs without executing.',
    buildPrompt(context) {
      const url =
        process.env.AGENT_HARNESS_TARGET_URL ??
        context.scenario?.targetUrl ??
        getRequiredEnv('AGENT_HARNESS_TARGET_URL');
      const method =
        process.env.AGENT_HARNESS_METHOD ?? context.scenario?.method ?? 'GET';
      const headers = loadJsonPromptValue({
        label: 'headers',
        inlineValue: process.env.AGENT_HARNESS_HEADERS_JSON,
        filePath: process.env.AGENT_HARNESS_HEADERS_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.headers),
      });
      const body = loadJsonPromptValue({
        label: 'body',
        inlineValue: process.env.AGENT_HARNESS_BODY_JSON,
        filePath: process.env.AGENT_HARNESS_BODY_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.body),
      });
      const externalMetadata = loadJsonPromptValue({
        label: 'external metadata',
        inlineValue: process.env.AGENT_HARNESS_EXTERNAL_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_EXTERNAL_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.externalMetadata),
      });

      return [
        'Inspect a candidate request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          externalMetadata,
        }),
        'Treat externalMetadata as advisory when merchant challenge hints disagree.',
        'Call prepare_paid_request exactly once, do not execute, and explain the resulting nextAction, challengeDetails, validationIssues, and whether the caller should revise, treat the request as passthrough, or stop because required business inputs are still missing.',
      ].join(' ');
    },
  },
};

function printHelp() {
  console.log(`OpenAI live harness example for @402flow/sdk

Usage:
  npm run example:openai-harness -- --prompt "Prepare and execute a paid image request"

Required environment:
  OPENAI_API_KEY
  X402FLOW_CONTROL_PLANE_BASE_URL
  X402FLOW_ORGANIZATION
  X402FLOW_AGENT
  One of: X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN

Optional environment:
  OPENAI_MODEL           Default: ${defaultModel}

Optional flags:
  --prompt <text>        User task prompt for the model
  --preset <name>        Use a named prompt preset
  --scenario <name>      Use a named scenario fixture pack
  --list-scenarios       List available scenario fixture packs
  --list-presets         List available prompt presets
  --model <id>           Override OPENAI_MODEL
  --max-turns <number>   Maximum tool loop turns. Default: ${defaultMaxTurns}
  --ttl-ms <number>      Prepared request TTL. Default: ${defaultPreparedTtlMs}
  --transcript-file <p>  Write the live run transcript to a JSON file. Defaults to ./tmp/scenario-runs/<scenario>-run-<timestamp>.json for scenario runs.
  --help                 Show this help

Prompt presets:
${Object.entries(promptPresets)
  .map(([name, preset]) => `  ${name.padEnd(18)} ${preset.description}`)
  .join('\n')}

JSON preset inputs:
  AGENT_HARNESS_HEADERS_JSON or AGENT_HARNESS_HEADERS_FILE
  AGENT_HARNESS_BODY_JSON or AGENT_HARNESS_BODY_FILE
  AGENT_HARNESS_EXTERNAL_METADATA_JSON or AGENT_HARNESS_EXTERNAL_METADATA_FILE

Scenario fixture packs:
${Object.keys(scenarioCatalog)
  .map((name) => `  ${name}`)
  .join('\n')}
`);
}

function parseArgs(argv) {
  const result = {
    prompt: undefined,
    preset: undefined,
    scenario: undefined,
    model: defaultModel,
    maxTurns: defaultMaxTurns,
    preparedTtlMs: defaultPreparedTtlMs,
    transcriptFile: undefined,
    help: false,
    listPresets: false,
    listScenarios: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help') {
      result.help = true;
      continue;
    }

    if (argument === '--prompt') {
      result.prompt = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--preset') {
      result.preset = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--scenario') {
      result.scenario = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--list-scenarios') {
      result.listScenarios = true;
      continue;
    }

    if (argument === '--list-presets') {
      result.listPresets = true;
      continue;
    }

    if (argument === '--model') {
      result.model = argv[index + 1] ?? result.model;
      index += 1;
      continue;
    }

    if (argument === '--max-turns') {
      result.maxTurns = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--ttl-ms') {
      result.preparedTtlMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--transcript-file') {
      result.transcriptFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (!argument.startsWith('--') && !result.prompt) {
      result.prompt = argument;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return result;
}

function resolvePrompt(args) {
  const scenario = resolveScenario(args);

  if (args.prompt && args.preset) {
    throw new Error('Use either --prompt or --preset, not both.');
  }

  if (args.prompt) {
    return {
      prompt: args.prompt,
      scenario,
    };
  }

  if (args.preset) {
    const preset = promptPresets[args.preset];
    if (!preset) {
      throw new Error(`Unknown prompt preset: ${args.preset}`);
    }

    return {
      prompt: preset.buildPrompt({ scenario }),
      scenario,
    };
  }

  return {
    prompt: undefined,
    scenario,
  };
}

function printPresets() {
  for (const [name, preset] of Object.entries(promptPresets)) {
    console.log(`${name}: ${preset.description}`);
  }
}

function printScenarios() {
  for (const name of Object.keys(scenarioCatalog)) {
    const scenario = loadOpenAiHarnessScenario(scenarioCatalog[name]);
    console.log(`${name}: ${scenario.description}`);
  }
}

async function writeTranscriptFile(filePath, transcript) {
  const resolvedPath = resolve(filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(`${resolvedPath}`, serializeOpenAiHarnessTranscript(transcript));

  return resolvedPath;
}

async function runHarnessSession({
  prompt,
  preset,
  model,
  maxTurns,
  preparedTtlMs,
  scenario,
}) {
  const apiKey = getRequiredEnv('OPENAI_API_KEY');
  const openai = createOpenAiClient(apiKey);
  const client = await createClientFromEnv('harness');
  const harness = new AgentHarness({
    client,
    preparedTtlMs,
  });
  const tools = createToolHandlers(harness);
  const instructions = defaultInstructions;
  let transcript = createOpenAiHarnessTranscript({
    preset,
    scenario,
    model,
    prompt,
    maxTurns,
    preparedTtlMs,
    instructions,
  });

  const result = await runOpenAiToolsSession({
    openai,
    model,
    prompt,
    instructions,
    handlers: tools,
    maxTurns,
    maxTurnsExceededMessage: `Exceeded max turns (${maxTurns}) before the model finished.`,
    onToolCall({
      turn,
      responseId,
      toolCall,
      rawArguments,
      parsedArguments,
      result: toolResult,
    }) {
      transcript = appendOpenAiHarnessToolCall(transcript, {
        turn,
        responseId,
        callId: toolCall.call_id,
        name: toolCall.name,
        rawArguments,
        parsedArguments,
        result: toolResult,
      });

      console.log(`\n[tool] ${toolCall.name}`);
      console.log(JSON.stringify(toolResult, null, 2));
    },
  });

  return {
    response: result.response,
    finalText: result.finalText,
    transcript: finalizeOpenAiHarnessTranscript(transcript, {
      finalResponseId: result.response.id,
      finalText: result.finalText,
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listPresets) {
    printPresets();
    return;
  }

  if (args.listScenarios) {
    printScenarios();
    return;
  }

  const promptResolution = resolvePrompt(args);
  const prompt = promptResolution?.prompt;

  if (!prompt) {
    throw new Error('Provide a prompt with --prompt, use a positional prompt, or select --preset.');
  }

  if (!Number.isInteger(args.maxTurns) || args.maxTurns <= 0) {
    throw new Error('--max-turns must be a positive integer.');
  }

  if (!Number.isInteger(args.preparedTtlMs) || args.preparedTtlMs <= 0) {
    throw new Error('--ttl-ms must be a positive integer.');
  }

  if (
    args.transcriptFile !== undefined &&
    (typeof args.transcriptFile !== 'string' || args.transcriptFile.length === 0)
  ) {
    throw new Error('--transcript-file must be a non-empty path.');
  }

  const transcriptFile =
    args.transcriptFile ??
    (promptResolution?.scenario
      ? defaultTranscriptFileForScenario(promptResolution.scenario.name)
      : undefined);

  console.log(`[model] ${args.model}`);
  if (args.preset) {
    console.log(`[preset] ${args.preset}`);
  }
  if (promptResolution?.scenario) {
    console.log(`[scenario] ${promptResolution.scenario.name}`);
  }
  console.log(`[prompt] ${prompt}`);

  const result = await runHarnessSession({
    ...args,
    prompt,
    preset: args.preset,
    scenario: promptResolution?.scenario?.name,
  });

  if (transcriptFile) {
    const transcriptPath = await writeTranscriptFile(
      transcriptFile,
      result.transcript,
    );
    console.log(`[transcript] ${transcriptPath}`);
  }

  console.log('\n[final]');
  console.log(result.finalText || '(no final text returned)');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});