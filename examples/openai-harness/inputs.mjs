import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function parseJsonValue(rawValue, label) {
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `${label} must contain valid JSON. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
}

export function loadJsonPromptValue(options) {
  if (options.inlineValue && options.filePath) {
    throw new Error(
      `${options.label} cannot be provided as both inline JSON and a file path.`,
    );
  }

  if (options.filePath) {
    const resolvedPath = resolve(options.filePath);
    const fileContents = readFileSync(resolvedPath, 'utf8');

    return JSON.stringify(parseJsonValue(fileContents, options.label));
  }

  if (options.inlineValue) {
    return JSON.stringify(parseJsonValue(options.inlineValue, options.label));
  }

  if (options.defaultValue !== undefined) {
    return JSON.stringify(parseJsonValue(options.defaultValue, options.label));
  }

  if (options.required) {
    throw new Error(
      `Missing required ${options.label}. Provide inline JSON or a JSON file path.`,
    );
  }

  return undefined;
}

export function loadOpenAiHarnessScenario(filePath) {
  const resolvedPath = resolve(filePath);
  const fileContents = readFileSync(resolvedPath, 'utf8');
  const parsedValue = parseJsonValue(fileContents, 'scenario file');

  if (!isRecord(parsedValue)) {
    throw new Error('Scenario file must contain a JSON object.');
  }

  if (typeof parsedValue.name !== 'string' || parsedValue.name.length === 0) {
    throw new Error('Scenario file must contain a non-empty name string.');
  }

  if (
    typeof parsedValue.description !== 'string' ||
    parsedValue.description.length === 0
  ) {
    throw new Error('Scenario file must contain a non-empty description string.');
  }

  if (typeof parsedValue.targetUrl !== 'string' || parsedValue.targetUrl.length === 0) {
    throw new Error('Scenario file must contain a non-empty targetUrl string.');
  }

  if (parsedValue.method !== undefined && typeof parsedValue.method !== 'string') {
    throw new Error('Scenario file method must be a string when provided.');
  }

  if (parsedValue.headers !== undefined && !isStringRecord(parsedValue.headers)) {
    throw new Error('Scenario file headers must be an object of string values.');
  }

  return {
    name: parsedValue.name,
    description: parsedValue.description,
    targetUrl: parsedValue.targetUrl,
    ...(parsedValue.task !== undefined && typeof parsedValue.task === 'string'
      ? { task: parsedValue.task }
      : {}),
    ...(parsedValue.method ? { method: parsedValue.method } : {}),
    ...(parsedValue.headers ? { headers: parsedValue.headers } : {}),
    ...(parsedValue.body !== undefined ? { body: parsedValue.body } : {}),
    ...(parsedValue.discoveryMetadata !== undefined
      ? { discoveryMetadata: parsedValue.discoveryMetadata }
      : {}),
  };
}