import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const defaultFirstPartyMerchantBaseUrl = 'http://127.0.0.1:4123';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const supportedScenarioOutcomeKinds = new Set([
  'success',
  'denied',
  'execution_pending',
  'execution_inconclusive',
  'execution_failed',
  'preflight_failed',
  'paid_fulfillment_failed',
]);

function validateScenarioMock(value) {
  return isRecord(value) && isRecord(value.prepareResult) && isRecord(value.executeOutcome);
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

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function resolveFirstPartyTargetUrl(targetUrl) {
  let parsedTargetUrl;

  try {
    parsedTargetUrl = new URL(targetUrl);
  } catch (error) {
    throw new Error(
      `Scenario targetUrl must be a valid absolute URL. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }

  const isFirstPartyDemoMerchantPath = parsedTargetUrl.pathname.startsWith('/demo-merchant/');
  const isLocalDemoHost = ['127.0.0.1', 'localhost'].includes(parsedTargetUrl.hostname);

  if (!isFirstPartyDemoMerchantPath || !isLocalDemoHost) {
    return targetUrl;
  }

  const configuredBaseUrlRaw =
    process.env.X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL ??
    defaultFirstPartyMerchantBaseUrl;
  const configuredBaseUrl = stripTrailingSlash(configuredBaseUrlRaw.trim());

  let parsedBaseUrl;

  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch (error) {
    throw new Error(
      `X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL must be a valid absolute URL. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }

  return `${parsedBaseUrl.origin}${parsedTargetUrl.pathname}${parsedTargetUrl.search}${parsedTargetUrl.hash}`;
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

  if (
    parsedValue.expectedOutcomeKind !== undefined
    && (typeof parsedValue.expectedOutcomeKind !== 'string'
      || !supportedScenarioOutcomeKinds.has(parsedValue.expectedOutcomeKind))
  ) {
    throw new Error('Scenario file expectedOutcomeKind must be a supported outcome string when provided.');
  }

  if (
    parsedValue.expectedFinalTextIncludes !== undefined
    && !isStringArray(parsedValue.expectedFinalTextIncludes)
  ) {
    throw new Error('Scenario file expectedFinalTextIncludes must be an array of strings when provided.');
  }

  if (parsedValue.mock !== undefined && !validateScenarioMock(parsedValue.mock)) {
    throw new Error('Scenario file mock must contain object prepareResult and executeOutcome fields.');
  }

  return {
    name: parsedValue.name,
    description: parsedValue.description,
    targetUrl: resolveFirstPartyTargetUrl(parsedValue.targetUrl),
    ...(parsedValue.task !== undefined && typeof parsedValue.task === 'string'
      ? { task: parsedValue.task }
      : {}),
    ...(parsedValue.method ? { method: parsedValue.method } : {}),
    ...(parsedValue.headers ? { headers: parsedValue.headers } : {}),
    ...(parsedValue.body !== undefined ? { body: parsedValue.body } : {}),
    ...(parsedValue.externalMetadata !== undefined
      ? { externalMetadata: parsedValue.externalMetadata }
      : {}),
    ...(parsedValue.expectedOutcomeKind !== undefined
      ? { expectedOutcomeKind: parsedValue.expectedOutcomeKind }
      : {}),
    ...(parsedValue.expectedFinalTextIncludes !== undefined
      ? { expectedFinalTextIncludes: parsedValue.expectedFinalTextIncludes }
      : {}),
    ...(parsedValue.mock !== undefined ? { mock: parsedValue.mock } : {}),
  };
}