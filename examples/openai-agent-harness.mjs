#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AgentPayClient, AgentHarness } from '../dist/index.js';
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

const defaultModel = process.env.OPENAI_MODEL ?? 'gpt-5.4';
const defaultMaxTurns = 8;
const defaultPreparedTtlMs = 5 * 60 * 1000;

const scenarioCatalog = {
  'image-ready': './examples/scenarios/image-ready.json',
  'image-revise': './examples/scenarios/image-revise.json',
  'nickeljoke-compat': './examples/scenarios/nickeljoke-compat.json',
  'nickeljoke-reasoning-revise': './examples/scenarios/nickeljoke-reasoning-revise.json',
  'auor-public-holidays-reasoning-revise': './examples/scenarios/auor-public-holidays-reasoning-revise.json',
  'quicknode-solana-devnet-bazaar-revise': './examples/scenarios/quicknode-solana-devnet-bazaar-revise.json',
  'solana-devnet-research-brief-ready': './examples/scenarios/solana-devnet-research-brief-ready.json',
  'solana-devnet-research-brief-revise': './examples/scenarios/solana-devnet-research-brief-revise.json',
  'x402-org-protected-ready': './examples/scenarios/x402-org-protected-ready.json',
};

function stringifyDefaultJson(value) {
  return value === undefined ? undefined : JSON.stringify(value);
}

function buildPromptRequestLines({ method, url, headers, body, discoveryMetadata }) {
  return [
    `Use ${method} ${url}.`,
    ...(headers ? [`Use headers ${headers}.`] : []),
    ...(body ? [`Use body ${body}.`] : []),
    ...(discoveryMetadata
      ? [`Use this discoveryMetadata during preparation: ${discoveryMetadata}.`]
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
      'Prepare and execute a JSON POST request using inline JSON or JSON fixture files for body, headers, and optional discovery metadata.',
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
      const discoveryMetadata = loadJsonPromptValue({
        label: 'discovery metadata',
        inlineValue: process.env.AGENT_HARNESS_DISCOVERY_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_DISCOVERY_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.discoveryMetadata),
      });

      return [
        'Prepare and execute a paid HTTP request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          discoveryMetadata,
        }),
        !discoveryMetadata
          ? 'Do not invent discoveryMetadata beyond what is explicitly provided.'
          : undefined,
        'Execute only if preparation returns nextAction as execute.',
        'After execution, call get_execution_result and summarize the stored result.',
      ]
        .filter(Boolean)
        .join(' ');
    },
  },
  'revise-json-post': {
    description:
      'Prepare a JSON POST request, revise it once if validationIssues require changes, then execute only after the second prepare is ready, using file-backed fixtures when convenient.',
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
      const discoveryMetadata = loadJsonPromptValue({
        label: 'discovery metadata',
        inlineValue: process.env.AGENT_HARNESS_DISCOVERY_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_DISCOVERY_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.discoveryMetadata),
      });

      return [
        'Prepare a paid HTTP request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          discoveryMetadata,
        }),
        'If preparation returns nextAction as revise_request, revise the request once using validationIssues and hints, prepare again, and then execute only if the revised request is ready.',
        'If preparation returns nextAction as execute but hints still describe missing required body fields, revise once using hints.requestBodyExample (or discoveryMetadata.requestBodyExample when provided), prepare again, and execute only after the revised prepare is ready.',
        'After execution, call get_execution_result and summarize the stored result.',
      ].join(' ');
    },
  },
  'revise-get-query': {
    description:
      'Send a GET request, derive missing query params from validationIssues and hints after a 402, revise the URL once, then execute.',
    buildPrompt(context) {
      const url =
        process.env.AGENT_HARNESS_TARGET_URL ??
        context.scenario?.targetUrl ??
        getRequiredEnv('AGENT_HARNESS_TARGET_URL');
      const task = context.scenario?.task ?? process.env.AGENT_HARNESS_TASK;
      const discoveryMetadata = loadJsonPromptValue({
        label: 'discovery metadata',
        inlineValue: process.env.AGENT_HARNESS_DISCOVERY_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_DISCOVERY_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.discoveryMetadata),
      });

      return [
        task ?? 'Fetch data from a paid API.',
        `Use the Auor-compatible endpoint at ${url}.`,
        'First, call prepare_paid_request with method GET and the bare URL (no query params).',
        'If preparation returns nextAction as revise_request, inspect validationIssues and hints.requestQueryParams to determine what query parameters are required.',
        'Reason about the correct values for each required parameter based on the task above, then call prepare_paid_request again with those query params appended to the URL.',
        'Execute only after the revised preparation returns nextAction as execute.',
        'After execution, call get_execution_result and summarize the stored result.',
        !discoveryMetadata
          ? 'Do not invent discoveryMetadata — all hints come from the merchant challenge.'
          : undefined,
      ]
        .filter(Boolean)
        .join(' ');
    },
  },
  'inspect-only': {
    description:
      'Prepare a candidate request and stop after explaining the preparation result and next action without executing.',
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
      const discoveryMetadata = loadJsonPromptValue({
        label: 'discovery metadata',
        inlineValue: process.env.AGENT_HARNESS_DISCOVERY_METADATA_JSON,
        filePath: process.env.AGENT_HARNESS_DISCOVERY_METADATA_FILE,
        defaultValue: stringifyDefaultJson(context.scenario?.discoveryMetadata),
      });

      return [
        'Inspect a candidate request through 402flow.',
        ...buildPromptRequestLines({
          method,
          url,
          headers,
          body,
          discoveryMetadata,
        }),
        'Call prepare_paid_request exactly once, do not execute, and explain the resulting nextAction and validationIssues.',
      ].join(' ');
    },
  },
};

const toolDefinitions = [
  {
    type: 'function',
    name: 'prepare_paid_request',
    description:
      'Prepare a candidate HTTP request for paid execution and inspect payment terms, validation issues, and nextAction before paying.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute merchant URL to prepare.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        },
        headers: {
          type: 'object',
        },
        body: {
          type: 'string',
        },
        discoveryMetadata: {
          type: 'object',
        },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'execute_prepared_request',
    description:
      'Execute a previously prepared paid request by preparedId only after preparation shows nextAction is execute.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        preparedId: {
          type: 'string',
        },
        executionContext: {
          type: 'object',
        },
      },
      required: ['preparedId'],
    },
  },
  {
    type: 'function',
    name: 'get_execution_result',
    description:
      'Read back the stored execution result for a prepared request, including rejected local outcomes.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        preparedId: {
          type: 'string',
        },
      },
      required: ['preparedId'],
    },
  },
];

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
  --transcript-file <p>  Write the live run transcript to a JSON file. Defaults to ./tmp/<scenario>-run-<timestamp>.json for scenario runs.
  --help                 Show this help

Prompt presets:
${Object.entries(promptPresets)
  .map(([name, preset]) => `  ${name.padEnd(18)} ${preset.description}`)
  .join('\n')}

JSON preset inputs:
  AGENT_HARNESS_HEADERS_JSON or AGENT_HARNESS_HEADERS_FILE
  AGENT_HARNESS_BODY_JSON or AGENT_HARNESS_BODY_FILE
  AGENT_HARNESS_DISCOVERY_METADATA_JSON or AGENT_HARNESS_DISCOVERY_METADATA_FILE

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

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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

function formatTranscriptTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function defaultTranscriptFileForScenario(scenarioName) {
  const timestamp = formatTranscriptTimestamp(new Date());

  return `./tmp/${scenarioName}-run-${timestamp}.json`;
}

async function writeTranscriptFile(filePath, transcript) {
  const resolvedPath = resolve(filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(`${resolvedPath}`, serializeOpenAiHarnessTranscript(transcript));

  return resolvedPath;
}

function createClientFromEnv() {
  const controlPlaneBaseUrl = getRequiredEnv('X402FLOW_CONTROL_PLANE_BASE_URL');
  const organization = getRequiredEnv('X402FLOW_ORGANIZATION');
  const agent = getRequiredEnv('X402FLOW_AGENT');
  const bootstrapKey = process.env.X402FLOW_BOOTSTRAP_KEY;
  const runtimeToken = process.env.X402FLOW_RUNTIME_TOKEN;

  if (!bootstrapKey && !runtimeToken) {
    throw new Error(
      'Set X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN before running the harness.',
    );
  }

  return new AgentPayClient({
    controlPlaneBaseUrl,
    organization,
    agent,
    auth: bootstrapKey
      ? {
          type: 'bootstrapKey',
          bootstrapKey,
        }
      : {
          type: 'runtimeToken',
          runtimeToken,
        },
  });
}

function createOpenAiClient(apiKey) {
  async function createResponse(body) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseBody = await response.json();

    if (!response.ok) {
      const message = responseBody?.error?.message ?? response.statusText;
      throw new Error(`OpenAI Responses API failed: ${message}`);
    }

    return responseBody;
  }

  return {
    createResponse,
  };
}

function parseToolArguments(rawArguments) {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createToolError(code, message) {
  return {
    toolError: {
      code,
      message,
    },
  };
}

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function isStringRecord(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function validatePreparationField(value) {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    isOptionalString(value.type) &&
    isOptionalString(value.description) &&
    (value.required === undefined || typeof value.required === 'boolean')
  );
}

function validatePreparationMetadata(value) {
  return (
    isPlainObject(value) &&
    isOptionalString(value.description) &&
    isOptionalString(value.requestBodyType) &&
    isOptionalString(value.requestBodyExample) &&
    (value.requestBodyFields === undefined ||
      (Array.isArray(value.requestBodyFields) &&
        value.requestBodyFields.every(validatePreparationField))) &&
    (value.requestQueryParams === undefined ||
      (Array.isArray(value.requestQueryParams) &&
        value.requestQueryParams.every(validatePreparationField))) &&
    (value.requestPathParams === undefined ||
      (Array.isArray(value.requestPathParams) &&
        value.requestPathParams.every(validatePreparationField))) &&
    (value.notes === undefined ||
      (Array.isArray(value.notes) &&
        value.notes.every((entry) => typeof entry === 'string')))
  );
}

function validatePrepareArgs(args) {
  if (!isPlainObject(args)) {
    return createToolError('invalid_arguments', 'prepare_paid_request expects an object.');
  }

  if (typeof args.url !== 'string' || args.url.length === 0) {
    return createToolError('invalid_arguments', 'prepare_paid_request requires a non-empty url string.');
  }

  if (!isOptionalString(args.method)) {
    return createToolError('invalid_arguments', 'method must be a string when provided.');
  }

  if (!isOptionalString(args.body)) {
    return createToolError('invalid_arguments', 'body must be a string when provided.');
  }

  if (args.headers !== undefined && !isStringRecord(args.headers)) {
    return createToolError('invalid_arguments', 'headers must be an object of string values.');
  }

  if (args.discoveryMetadata !== undefined) {
    if (!isPlainObject(args.discoveryMetadata)) {
      return createToolError('invalid_arguments', 'discoveryMetadata must be an object when provided.');
    }

    if (
      args.discoveryMetadata.provider !== undefined &&
      !validatePreparationMetadata(args.discoveryMetadata.provider)
    ) {
      return createToolError('invalid_arguments', 'discoveryMetadata.provider is invalid.');
    }

    if (
      args.discoveryMetadata.marketplace !== undefined &&
      !validatePreparationMetadata(args.discoveryMetadata.marketplace)
    ) {
      return createToolError('invalid_arguments', 'discoveryMetadata.marketplace is invalid.');
    }
  }

  return null;
}

function validatePreparedIdArgs(toolName, args) {
  if (!isPlainObject(args)) {
    return createToolError('invalid_arguments', `${toolName} expects an object.`);
  }

  if (typeof args.preparedId !== 'string') {
    return createToolError('invalid_arguments', `${toolName} requires preparedId as a string.`);
  }

  return null;
}

function createToolHandlers(harness) {
  return {
    async prepare_paid_request(args) {
      const validationError = validatePrepareArgs(args);
      if (validationError) {
        return validationError;
      }

      return harness.preparePaidRequest(args);
    },

    async execute_prepared_request(args) {
      const validationError = validatePreparedIdArgs('execute_prepared_request', args);
      if (validationError) {
        return validationError;
      }

      return harness.executePreparedRequest(args);
    },

    async get_execution_result(args) {
      const validationError = validatePreparedIdArgs('get_execution_result', args);
      if (validationError) {
        return validationError;
      }

      try {
        return harness.getExecutionResult(args.preparedId);
      } catch (error) {
        return createToolError(
          'tool_execution_failed',
          error instanceof Error ? error.message : 'get_execution_result failed.',
        );
      }
    },
  };
}

function extractFunctionCalls(response) {
  if (!Array.isArray(response.output)) {
    return [];
  }

  return response.output.filter((item) => item.type === 'function_call');
}

function renderFinalText(response) {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return '';
  }

  const message = response.output.find((item) => item.type === 'message');
  if (!message || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
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
  const client = createClientFromEnv();
  const harness = new AgentHarness({
    client,
    preparedTtlMs,
  });
  const tools = createToolHandlers(harness);
  const instructions = [
    'You are testing paid API execution through 402flow.',
    'Always call prepare_paid_request before any paid execution.',
    'Only call execute_prepared_request after preparation shows the request is ready for paid execution.',
    'Use discoveryMetadata only when the caller already has endpoint metadata.',
    'Do not invent missing business parameters.',
    'If the request is not ready, explain what you would revise.',
    'After execution, call get_execution_result before giving your final summary.',
  ].join(' ');
  let transcript = createOpenAiHarnessTranscript({
    preset,
    scenario,
    model,
    prompt,
    maxTurns,
    preparedTtlMs,
    instructions,
  });

  let response = await openai.createResponse({
    model,
    instructions,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
        ],
      },
    ],
    tools: toolDefinitions,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_output_tokens: 2_000,
  });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const functionCalls = extractFunctionCalls(response);

    if (functionCalls.length === 0) {
      return {
        response,
        finalText: renderFinalText(response),
        transcript: finalizeOpenAiHarnessTranscript(transcript, {
          finalResponseId: response.id,
          finalText: renderFinalText(response),
        }),
      };
    }

    const toolOutputs = [];

    for (const toolCall of functionCalls) {
      const args = parseToolArguments(toolCall.arguments);
      const handler = tools[toolCall.name];
      const result = !handler
        ? createToolError('unknown_tool', `Unknown tool requested: ${toolCall.name}`)
        : args === null
          ? createToolError('invalid_arguments', `Could not parse arguments for ${toolCall.name}.`)
          : await handler(args);

      transcript = appendOpenAiHarnessToolCall(transcript, {
        turn: turn + 1,
        responseId: response.id,
        callId: toolCall.call_id,
        name: toolCall.name,
        rawArguments: toolCall.arguments,
        parsedArguments: args,
        result,
      });

      console.log(`\n[tool] ${toolCall.name}`);
      console.log(JSON.stringify(result, null, 2));

      toolOutputs.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
      });
    }

    response = await openai.createResponse({
      model,
      previous_response_id: response.id,
      input: toolOutputs,
      tools: toolDefinitions,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_output_tokens: 2_000,
    });
  }

  throw new Error(`Exceeded max turns (${maxTurns}) before the model finished.`);
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