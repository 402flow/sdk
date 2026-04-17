import './load-env.mjs';

import { AgentPayClient } from '../dist/index.js';

export const defaultModel = process.env.OPENAI_MODEL ?? 'gpt-5.4';
export const defaultMaxTurns = 8;

const defaultToolDefinitions = [
  {
    type: 'function',
    name: 'prepare_paid_request',
    description:
      'Prepare a candidate paid HTTP request and inspect payment terms, parsed challenge details, request hints, and nextAction before execution.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        },
        headers: { type: 'object' },
        body: { type: 'string' },
        externalMetadata: { type: 'object' },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'execute_prepared_request',
    description:
      'Execute a previously prepared paid request only after preparation says the request is ready.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        preparedId: { type: 'string' },
        executionContext: { type: 'object' },
      },
      required: ['preparedId'],
    },
  },
  {
    type: 'function',
    name: 'get_execution_result',
    description:
      'Read the stored execution result for a prepared paid request after execution completes.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        preparedId: { type: 'string' },
      },
      required: ['preparedId'],
    },
  },
];

export const defaultInstructions = [
  'Safely orchestrate paid HTTP requests through 402flow.',
  'Always call prepare_paid_request before any paid execution.',
  'Inspect challengeDetails when present for merchant resource metadata, advertised payment candidates, and extension-published discovery data.',
  'Only call execute_prepared_request when preparation returns nextAction as execute.',
  'If preparation returns nextAction as treat_as_passthrough, do not pay and explain that paid execution is not required.',
  'If preparation returns nextAction as revise_request, use validationIssues, hints, and challengeDetails.extensions when present to revise only when the task provides enough information; otherwise stop and explain what is still missing.',
  'Use externalMetadata only when the caller already has endpoint metadata, and treat it as advisory when merchant challenge hints disagree.',
  'Do not invent missing business parameters or execute the same prepared request twice unless the caller explicitly asks for a retry.',
  'After execution, call get_execution_result before your final summary and report denied, pending, failed, or inconclusive outcomes clearly.',
].join(' ');

export function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function createClientFromEnv(exampleName = 'example') {
  const controlPlaneBaseUrl = getRequiredEnv('X402FLOW_CONTROL_PLANE_BASE_URL');
  const organization = getRequiredEnv('X402FLOW_ORGANIZATION');
  const agent = getRequiredEnv('X402FLOW_AGENT');
  const bootstrapKey = process.env.X402FLOW_BOOTSTRAP_KEY;
  const runtimeToken = process.env.X402FLOW_RUNTIME_TOKEN;

  if (!bootstrapKey && !runtimeToken) {
    throw new Error(
      `Set X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN before running the ${exampleName}.`,
    );
  }

  return new AgentPayClient({
    controlPlaneBaseUrl,
    organization,
    agent,
    auth: bootstrapKey
      ? { type: 'bootstrapKey', bootstrapKey }
      : { type: 'runtimeToken', runtimeToken },
  });
}

export function createOpenAiClient(apiKey) {
  return {
    async createResponse(body) {
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
    },
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

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function isStringRecord(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
}

function looksLikeJsonBody(body) {
  const trimmed = body.trim();

  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function validatePreparationField(value) {
  return (
    isPlainObject(value)
    && typeof value.name === 'string'
    && isOptionalString(value.type)
    && isOptionalString(value.description)
    && (value.required === undefined || typeof value.required === 'boolean')
  );
}

function validateExternalMetadata(value) {
  return (
    isPlainObject(value)
    && isOptionalString(value.description)
    && isOptionalString(value.requestBodyType)
    && isOptionalString(value.requestBodyExample)
    && (value.requestBodyFields === undefined
      || (Array.isArray(value.requestBodyFields)
        && value.requestBodyFields.every(validatePreparationField)))
    && (value.requestQueryParams === undefined
      || (Array.isArray(value.requestQueryParams)
        && value.requestQueryParams.every(validatePreparationField)))
    && (value.requestPathParams === undefined
      || (Array.isArray(value.requestPathParams)
        && value.requestPathParams.every(validatePreparationField)))
    && (value.notes === undefined
      || (Array.isArray(value.notes)
        && value.notes.every((entry) => typeof entry === 'string')))
  );
}

function createToolError(code, message) {
  return {
    toolError: {
      code,
      message,
    },
  };
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

  if (
    args.externalMetadata !== undefined
    && !validateExternalMetadata(args.externalMetadata)
  ) {
    return createToolError('invalid_arguments', 'externalMetadata is invalid.');
  }

  return null;
}

function recoverNestedPrepareArgs(args) {
  if (!isPlainObject(args) || typeof args.body !== 'string') {
    return args;
  }

  let parsedBody;

  try {
    parsedBody = JSON.parse(args.body);
  } catch {
    return args;
  }

  if (!isPlainObject(parsedBody)) {
    return args;
  }

  const hasNestedEnvelope = (
    'headers' in parsedBody
    || 'externalMetadata' in parsedBody
    || ('body' in parsedBody && isPlainObject(parsedBody.body))
  );

  if (!hasNestedEnvelope) {
    return args;
  }

  const recoveredArgs = {
    ...args,
    ...(args.headers === undefined && isStringRecord(parsedBody.headers)
      ? { headers: parsedBody.headers }
      : {}),
    ...(args.externalMetadata === undefined && validateExternalMetadata(parsedBody.externalMetadata)
      ? { externalMetadata: parsedBody.externalMetadata }
      : {}),
  };

  if (typeof parsedBody.body === 'string') {
    return {
      ...recoveredArgs,
      body: parsedBody.body,
    };
  }

  if (isPlainObject(parsedBody.body) || Array.isArray(parsedBody.body)) {
    return {
      ...recoveredArgs,
      body: JSON.stringify(parsedBody.body),
    };
  }

  return recoveredArgs;
}

function inferJsonContentType(args) {
  if (!isPlainObject(args) || typeof args.body !== 'string' || !looksLikeJsonBody(args.body)) {
    return args;
  }

  if (args.headers === undefined) {
    return {
      ...args,
      headers: {
        'content-type': 'application/json',
      },
    };
  }

  if (!isStringRecord(args.headers) || hasContentTypeHeader(args.headers)) {
    return args;
  }

  return {
    ...args,
    headers: {
      ...args.headers,
      'content-type': 'application/json',
    },
  };
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

export function createToolHandlers(harness) {
  return {
    async prepare_paid_request(args) {
      const normalizedArgs = inferJsonContentType(recoverNestedPrepareArgs(args));
      const validationError = validatePrepareArgs(normalizedArgs);

      if (validationError) {
        return validationError;
      }

      return harness.preparePaidRequest(normalizedArgs);
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

export function renderFinalText(response) {
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

export async function runOpenAiToolsSession({
  openai,
  model = defaultModel,
  prompt,
  instructions = defaultInstructions,
  handlers,
  maxTurns = defaultMaxTurns,
  maxTurnsExceededMessage,
  onToolCall,
}) {
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
    tools: defaultToolDefinitions,
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
      };
    }

    const toolOutputs = [];

    for (const toolCall of functionCalls) {
      const args = parseToolArguments(toolCall.arguments);
      const handler = handlers[toolCall.name];
      const result = !handler
        ? createToolError('unknown_tool', `Unknown tool requested: ${toolCall.name}`)
        : args === null
          ? createToolError('invalid_arguments', `Could not parse arguments for ${toolCall.name}.`)
          : await handler(args);

      if (onToolCall) {
        await onToolCall({
          turn: turn + 1,
          responseId: response.id,
          toolCall,
          rawArguments: toolCall.arguments,
          parsedArguments: args,
          result,
        });
      }

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
      tools: defaultToolDefinitions,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_output_tokens: 2_000,
    });
  }

  throw new Error(
    maxTurnsExceededMessage
      ?? `Maximum turns (${maxTurns}) reached before the model returned a final answer.`,
  );
}