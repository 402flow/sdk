/**
 * Core public client surface for @402flow/sdk.
 *
 * The SDK exposes two primary integration styles:
 * 1. fetchPaid() for the fastest end-to-end paid request path
 * 2. preparePaidRequest() plus executePreparedRequest() when the caller wants
 *    an explicit check/revise/execute loop
 */
import { createHash } from 'node:crypto';

import {
  detectChallengeFromResponse,
  type DetectedChallenge,
} from './challenge-detection.js';
import {
  monetaryAmountToMinorUnits,
  paidRequestChallengeSchema,
  paidRequestHttpRequestSchema,
  sdkPaymentDecisionRequestSchema,
  sdkPaymentDecisionResponseSchema,
  type SdkExternalMetadata,
  type SdkPreparedHintField,
  type SdkPreparedHintValue,
  type SdkPreparedNextAction,
  type SdkPreparedPaidRequest,
  type SdkPreparedPaidRequestReady,
  type SdkPreparedPaymentRequirement,
  type SdkPreparedRequestHints,
  type SdkPreparedValidationIssue,
  sdkReceiptResponseSchema,
  type PaidRequestContext,
  type SdkMerchantResponse,
  type SdkPaymentDecisionResponse,
  type SdkReceipt,
  type SdkReceiptResponse,
} from './contracts.js';
import {
  sdkClientVersion,
  sdkClientVersionHeaderName,
} from './version.js';

/** Supported authentication modes for an SDK client. */
export type AgentPayAuth =
  | {
      type: 'bootstrapKey';
      bootstrapKey: string;
    }
  | {
      type: 'runtimeToken';
      runtimeToken: string;
    };

/** Identity bound to a client instance and applied to every paid request. */
export type AgentPayClientIdentity = Pick<
  PaidRequestContext,
  'organization' | 'agent'
>;

/** Configuration for a client connected to one control plane and one agent identity. */
export type AgentPayClientOptions = {
  controlPlaneBaseUrl: string;
  auth: AgentPayAuth;
  organization: string;
  agent: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

/** Request-scoped options for the fast fetchPaid() path. */
export type FetchPaidOptions = {
  challenge?: DetectedChallenge;
  idempotencyKey?: string;
};

/** Optional context for the preparation flow. */
export type PreparePaidRequestOptions = {
  challenge?: DetectedChallenge;
  externalMetadata?: SdkExternalMetadata;
};

/** Execution context accepted when paying a previously prepared request. */
export type ExecutePreparedRequest = Omit<FetchPaidRequest, 'challenge'>;

/** Request-scoped control-plane context accepted by fetchPaid(). */
export type FetchPaidRequest =
  Omit<PaidRequestContext, keyof AgentPayClientIdentity> & FetchPaidOptions;

/** Body types the SDK can safely replay through paid prepare/execute flows. */
export type ReplayableRequestBody = string | URLSearchParams;

type PaidProtocol = DetectedChallenge['protocol'];
type DenyDecision = Extract<SdkPaymentDecisionResponse, { outcome: 'deny' }>;
type ExecutingDecision = Extract<
  SdkPaymentDecisionResponse,
  { outcome: 'executing' }
>;
type InconclusiveDecision = Extract<
  SdkPaymentDecisionResponse,
  { outcome: 'inconclusive' }
>;
type ExecutionFailedDecision = Extract<
  SdkPaymentDecisionResponse,
  { outcome: 'execution_failed' }
>;
type PreflightFailedDecision = Extract<
  SdkPaymentDecisionResponse,
  { outcome: 'preflight_failed' }
>;
type PaidFulfillmentFailedDecision = Extract<
  SdkPaymentDecisionResponse,
  { outcome: 'paid_fulfillment_failed' }
>;
type RequestFailedDecision = {
  outcome: 'request_failed';
  status: number;
  message: string;
  body?: unknown;
};

type PaidResponseBase = {
  protocol: PaidProtocol | 'none';
  response: Response;
};

/** Returned when the merchant did not require payment for the request. */
export type PassthroughPaidResponse = PaidResponseBase & {
  kind: 'passthrough';
  protocol: 'none';
};

/** Returned when the paid request succeeded and a durable receipt exists. */
export type SuccessPaidResponse = PaidResponseBase & {
  kind: 'success';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  receiptId: string;
  receipt: SdkReceipt;
};

/** Failure result for paid requests that settled but did not fulfill successfully. */
export type PaidFulfillmentFailedResponse = PaidResponseBase & {
  kind: 'paid_fulfillment_failed';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  receiptId: string;
  receipt: SdkReceipt;
  reason: string;
  decision: PaidFulfillmentFailedDecision;
};

/** Failure result for policy denials before paid execution is allowed. */
export type DeniedPaidResponse = PaidResponseBase & {
  kind: 'denied';
  protocol: PaidProtocol;
  paidRequestId?: string;
  reason: string;
  decision: DenyDecision;
  policyReviewEventId?: string;
};

/** Failure result for idempotent retries that are still executing. */
export type ExecutionPendingPaidResponse = PaidResponseBase & {
  kind: 'execution_pending';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: ExecutingDecision;
};

/** Failure result when the merchant/control plane could not prove a final outcome. */
export type ExecutionInconclusivePaidResponse = PaidResponseBase & {
  kind: 'execution_inconclusive';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: InconclusiveDecision;
};

/** Failure result when paid execution started but ended in a hard failure. */
export type ExecutionFailedPaidResponse = PaidResponseBase & {
  kind: 'execution_failed';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: ExecutionFailedDecision;
};

/** Failure result when the request could not proceed on the selected payment rail. */
export type PreflightFailedPaidResponse = PaidResponseBase & {
  kind: 'preflight_failed';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: PreflightFailedDecision;
};

/** Failure result when the control-plane response itself could not be trusted as valid SDK output. */
export type RequestFailedPaidResponse = PaidResponseBase & {
  kind: 'request_failed';
  protocol: PaidProtocol;
  reason: string;
  decision: RequestFailedDecision;
};

export type FetchPaidFailureResponse =
  | PaidFulfillmentFailedResponse
  | DeniedPaidResponse
  | ExecutionPendingPaidResponse
  | ExecutionInconclusivePaidResponse
  | ExecutionFailedPaidResponse
  | PreflightFailedPaidResponse
  | RequestFailedPaidResponse;

export type PaidResponse = PassthroughPaidResponse | SuccessPaidResponse;

/**
 * Thrown for all non-success paid outcomes. The original typed failure payload is
 * preserved on details so callers can branch on kind without reparsing responses.
 */
export class FetchPaidError<
  TResponse extends FetchPaidFailureResponse = FetchPaidFailureResponse,
> extends Error {
  readonly details: TResponse;
  readonly kind: TResponse['kind'];
  readonly protocol: TResponse['protocol'];
  readonly response: Response;
  readonly reason: string;
  readonly decision: TResponse['decision'];
  readonly paidRequestId: string | undefined;
  readonly paymentAttemptId: string | undefined;
  readonly receiptId: string | undefined;
  readonly receipt: SdkReceipt | undefined;
  readonly policyReviewEventId: string | undefined;

  constructor(details: TResponse) {
    super(`${details.kind}: ${details.reason}`);
    this.name = 'FetchPaidError';
    this.details = details;
    this.kind = details.kind;
    this.protocol = details.protocol;
    this.response = details.response;
    this.reason = details.reason;
    this.decision = details.decision;
    this.paidRequestId = 'paidRequestId' in details ? details.paidRequestId : undefined;
    this.paymentAttemptId =
      'paymentAttemptId' in details ? details.paymentAttemptId : undefined;
    this.receiptId = 'receiptId' in details ? details.receiptId : undefined;
    this.receipt = 'receipt' in details ? details.receipt : undefined;
    this.policyReviewEventId =
      'policyReviewEventId' in details ? details.policyReviewEventId : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard for callers that catch unknown errors around fetchPaid flows. */
export function isFetchPaidError(error: unknown): error is FetchPaidError {
  return error instanceof FetchPaidError;
}

type CachedRuntimeToken = {
  token: string;
  expiresAtMs: number;
};

const defaultRuntimeTokenRefreshWindowMs = 30_000;

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) {
    return undefined;
  }

  const normalizedHeaders: Record<string, string> = {};
  const headerMap = new Headers(headers);

  headerMap.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  return normalizedHeaders;
}

function createJsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function createMerchantResponse(merchantResponse: SdkMerchantResponse) {
  return new Response(merchantResponse.body, {
    status: merchantResponse.status,
    headers: merchantResponse.headers,
  });
}

function createRawResponse(
  status: number,
  body: string,
  headers: HeadersInit | undefined,
) {
  return new Response(body, {
    status,
    ...(headers ? { headers } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getControlPlaneErrorMessage(body: unknown, fallback: string) {
  if (!isRecord(body)) {
    return fallback;
  }

  const message =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : fallback;
  const issues = body.issues;

  if (!isRecord(issues)) {
    return message;
  }

  const details: string[] = [];
  const formErrors = issues.formErrors;

  if (Array.isArray(formErrors)) {
    for (const entry of formErrors) {
      if (typeof entry === 'string' && entry.length > 0) {
        details.push(entry);
      }
    }
  }

  const fieldErrors = issues.fieldErrors;

  if (isRecord(fieldErrors)) {
    for (const [field, value] of Object.entries(fieldErrors)) {
      if (!Array.isArray(value)) {
        continue;
      }

      const fieldMessages = value.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );

      if (fieldMessages.length > 0) {
        details.push(`${field}: ${fieldMessages.join(', ')}`);
      }
    }
  }

  return details.length > 0 ? `${message} ${details.join(' ')}` : message;
}

async function readControlPlaneError(response: Response, fallback: string) {
  const responseBody = await response.text();
  const parsedBody = tryParseJson(responseBody);

  return {
    responseBody,
    parsedBody,
    message: getControlPlaneErrorMessage(parsedBody, fallback),
  };
}

function tryParseJson(value: string) {
  if (value.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function describeRequestBodyType(body: RequestInit['body']) {
  if (body === undefined || body === null) {
    return 'empty';
  }

  if (typeof body === 'string') {
    return 'string';
  }

  if (body instanceof URLSearchParams) {
    return 'URLSearchParams';
  }

  if (typeof body === 'object' && 'constructor' in body) {
    const constructorName = body.constructor?.name;

    if (typeof constructorName === 'string' && constructorName.length > 0) {
      return constructorName;
    }
  }

  return typeof body;
}

/** Returns true when a request body can be replayed exactly across paid flows. */
export function isReplayableRequestBody(
  body: RequestInit['body'],
): body is ReplayableRequestBody {
  return typeof body === 'string' || body instanceof URLSearchParams;
}

/** Serialize a paid-flow request body into the exact replayable wire representation. */
export function toReplayableRequestBody(body: RequestInit['body']) {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  throw new Error(
    `Paid requests require replayable string or URLSearchParams bodies. Received ${describeRequestBodyType(body)}. Convert JSON payloads with createJsonRequestBody(...) or form payloads with createFormUrlEncodedBody(...).`,
  );
}

/** Helper for callers that want an explicit JSON-string body for paid flows. */
export function createJsonRequestBody(payload: unknown) {
  return JSON.stringify(payload);
}

type FormUrlEncodedValue = string | number | boolean;
type FormUrlEncodedBodyInit = Record<
  string,
  FormUrlEncodedValue | readonly FormUrlEncodedValue[]
>;

/** Helper for callers that want a replayable form body for paid flows. */
export function createFormUrlEncodedBody(
  values: FormUrlEncodedBodyInit,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(values)) {
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        params.append(key, String(entry));
      }

      continue;
    }

    params.append(key, String(rawValue));
  }

  return params;
}

// Preparation and paid execution may need to replay the exact request body, so
// only body types that can be losslessly serialized are accepted here.
function getReplayableRequestBody(body: RequestInit['body']) {
  return toReplayableRequestBody(body);
}

function hashRequestBody(body: string | undefined) {
  if (!body) {
    return undefined;
  }

  return createHash('sha256').update(body).digest('hex');
}

function parseRuntimeTokenResponse(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Runtime token exchange returned an invalid payload.');
  }

  const token = (payload as { token?: unknown }).token;
  const expiresAt = (payload as { expiresAt?: unknown }).expiresAt;

  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Runtime token exchange response is missing token.');
  }

  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('Runtime token exchange response is missing expiresAt.');
  }

  return {
    token,
    expiresAt,
  };
}

function createPreparedHttpRequest(input: string, init: RequestInit) {
  const requestBody = getReplayableRequestBody(init.body);

  return paidRequestHttpRequestSchema.parse({
    url: input,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: normalizeHeaders(init.headers),
    body: requestBody,
    bodyHash: hashRequestBody(requestBody),
  });
}

function createPreparationAttribution(
  source: 'merchant_challenge' | 'external_metadata',
  authority: 'authoritative' | 'advisory',
  note?: string,
) {
  return {
    source,
    authority,
    ...(note ? { note } : {}),
  } as const;
}

function readExternalMetadata(
  options: PreparePaidRequestOptions,
): SdkExternalMetadata | undefined {
  return options.externalMetadata;
}

function readSchemaType(value: unknown) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const firstString = value.find(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );

    if (firstString) {
      return firstString;
    }
  }

  return undefined;
}

function readMerchantFieldsFromObjectSchema(
  objectSchema: Record<string, unknown>,
) : NonNullable<SdkExternalMetadata['requestBodyFields']> {
  const properties = isRecord(objectSchema.properties)
    ? objectSchema.properties
    : undefined;
  const required = Array.isArray(objectSchema.required)
    ? new Set(
        objectSchema.required.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        ),
      )
    : new Set<string>();
  const fields = new Map<string, NonNullable<SdkExternalMetadata['requestBodyFields']>[number]>();

  for (const [name, schema] of Object.entries(properties ?? {})) {
    const propertySchema = isRecord(schema) ? schema : {};
    fields.set(name.toLowerCase(), {
      name,
      ...(readSchemaType(propertySchema.type) ? { type: readSchemaType(propertySchema.type) } : {}),
      ...(readStringValue(propertySchema.description)
        ? { description: readStringValue(propertySchema.description) }
        : {}),
      ...(required.has(name) ? { required: true } : {}),
    });
  }

  for (const fieldName of required) {
    if (!fields.has(fieldName.toLowerCase())) {
      fields.set(fieldName.toLowerCase(), {
        name: fieldName,
        required: true,
      });
    }
  }

  return Array.from(fields.values());
}

function inferFieldTypeFromValue(value: unknown) {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return undefined;
  }

  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

function inferFieldsFromQueryParamExample(
  queryParams: Record<string, unknown>,
): NonNullable<SdkExternalMetadata['requestQueryParams']> {
  return Object.entries(queryParams).map(([name, value]) => ({
    name,
    ...(inferFieldTypeFromValue(value) ? { type: inferFieldTypeFromValue(value) } : {}),
    required: true,
  }));
}

async function resolveJsonSchemaRef(
  schema: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const ref = readStringValue(schema.$ref);

  if (!ref) {
    return schema;
  }

  try {
    const url = new URL(ref);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }

    const response = await fetchImpl(url.toString());
    if (!response.ok) {
      return undefined;
    }

    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readMerchantPreparationMetadataFromInputSchema(
  inputSchema: Record<string, unknown>,
  requestBodyExample: string | undefined,
  queryParamExample: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
): Promise<SdkExternalMetadata | undefined> {
  const bodyType = readStringValue(inputSchema.bodyType)
    ?? (isRecord(inputSchema.properties)
      && isRecord(inputSchema.properties.bodyType)
      ? readStringValue(inputSchema.properties.bodyType.const)
      : undefined);
  const bodySchema = isRecord(inputSchema.body)
    ? inputSchema.body
    : isRecord(inputSchema.properties)
      && isRecord(inputSchema.properties.body)
      ? inputSchema.properties.body
      : undefined;
  const queryParamSchema = isRecord(inputSchema.queryParams)
    ? inputSchema.queryParams
    : isRecord(inputSchema.properties)
      && isRecord(inputSchema.properties.queryParams)
      ? inputSchema.properties.queryParams
      : undefined;
  const requestBodyFields = bodySchema
    ? readMerchantFieldsFromObjectSchema(bodySchema)
    : undefined;
  const resolvedQueryParamSchema = queryParamSchema
    ? await resolveJsonSchemaRef(queryParamSchema, fetchImpl)
    : undefined;
  const requestQueryParams = resolvedQueryParamSchema
    ? readMerchantFieldsFromObjectSchema(resolvedQueryParamSchema)
    : queryParamExample
      ? inferFieldsFromQueryParamExample(queryParamExample)
      : undefined;

  const hasBodyFields = requestBodyFields && requestBodyFields.length > 0;
  const hasQueryFields = requestQueryParams && requestQueryParams.length > 0;

  if (!bodyType && !requestBodyExample && !hasBodyFields && !hasQueryFields) {
    return undefined;
  }

  return {
    ...(bodyType ? { requestBodyType: bodyType } : {}),
    ...(requestBodyExample ? { requestBodyExample } : {}),
    ...(hasBodyFields
      ? { requestBodyFields }
      : {}),
    ...(hasQueryFields
      ? { requestQueryParams }
      : {}),
    notes: ['Request hints derived from merchant challenge metadata.'],
  };
}

async function readMerchantPreparationMetadata(
  challenge: DetectedChallenge | undefined,
  fetchImpl: typeof fetch,
): Promise<SdkExternalMetadata | undefined> {
  if (!challenge) {
    return undefined;
  }

  const paymentRequiredPayload = tryParsePaymentRequiredHeader(
    challenge.headers['payment-required'],
  );
  const payload = unwrapChallengePayload(paymentRequiredPayload ?? challenge.body);

  if (!isRecord(payload)) {
    return undefined;
  }

  const accepts = Array.isArray(payload.accepts) ? payload.accepts : [];

  for (const accept of accepts) {
    if (!isRecord(accept) || !isRecord(accept.extra) || !isRecord(accept.extra.outputSchema)) {
      continue;
    }

    const outputSchema = accept.extra.outputSchema;
    const metadata = isRecord(outputSchema.input)
      ? await readMerchantPreparationMetadataFromInputSchema(
          outputSchema.input,
          undefined,
          undefined,
          fetchImpl,
        )
      : undefined;

    if (metadata) {
      return metadata;
    }
  }

  const bazaar = isRecord(payload.extensions) && isRecord(payload.extensions.bazaar)
    ? payload.extensions.bazaar
    : undefined;
  const bazaarInfoInput = isRecord(bazaar?.info) && isRecord(bazaar.info.input)
    ? bazaar.info.input
    : undefined;
  const bazaarRequestBodyExample = isRecord(bazaarInfoInput?.body)
    ? JSON.stringify(bazaarInfoInput.body)
    : undefined;
  const bazaarQueryParamExample = isRecord(bazaarInfoInput?.queryParams)
    ? bazaarInfoInput.queryParams
    : undefined;
  const bazaarInputSchema = isRecord(bazaar?.schema)
    && isRecord(bazaar.schema.properties)
    && isRecord(bazaar.schema.properties.input)
    ? bazaar.schema.properties.input
    : undefined;

  if (bazaarInputSchema) {
    return readMerchantPreparationMetadataFromInputSchema(
      bazaarInputSchema,
      bazaarRequestBodyExample,
      bazaarQueryParamExample,
      fetchImpl,
    );
  }

  return undefined;
}

function pickPreparedHintValue(
  options: PreparePaidRequestOptions,
  merchantChallengeMetadata: SdkExternalMetadata | undefined,
  key: 'description' | 'requestBodyType' | 'requestBodyExample',
): SdkPreparedHintValue | undefined {
  if (merchantChallengeMetadata?.[key]) {
    return {
      value: merchantChallengeMetadata[key],
      attribution: createPreparationAttribution('merchant_challenge', 'authoritative'),
    };
  }

  const externalMetadata = readExternalMetadata(options);

  if (externalMetadata?.[key]) {
    return {
      value: externalMetadata[key],
      attribution: createPreparationAttribution('external_metadata', 'advisory'),
    };
  }

  return undefined;
}

function mergePreparedHintFields(
  options: PreparePaidRequestOptions,
  merchantChallengeMetadata: SdkExternalMetadata | undefined,
  key: 'requestBodyFields' | 'requestQueryParams' | 'requestPathParams',
) {
  const fields = new Map<string, SdkPreparedHintField>();

  for (const field of merchantChallengeMetadata?.[key] ?? []) {
    fields.set(field.name.toLowerCase(), {
      ...field,
      attribution: createPreparationAttribution('merchant_challenge', 'authoritative'),
    });
  }

  for (const field of readExternalMetadata(options)?.[key] ?? []) {
    const normalizedName = field.name.toLowerCase();

    if (fields.has(normalizedName)) {
      continue;
    }

    fields.set(normalizedName, {
        ...field,
        attribution: createPreparationAttribution('external_metadata', 'advisory'),
      });
  }

  return Array.from(fields.values());
}

async function buildPreparedRequestHints(
  options: PreparePaidRequestOptions,
  fetchImpl: typeof fetch,
  challenge?: DetectedChallenge,
): Promise<SdkPreparedRequestHints> {
  // Hint assembly merges optional caller metadata with merchant-authoritative
  // challenge metadata while preserving attribution for every returned field.
  const merchantChallengeMetadata = await readMerchantPreparationMetadata(challenge, fetchImpl);
  const externalMetadata = readExternalMetadata(options);

  return {
    ...(pickPreparedHintValue(options, merchantChallengeMetadata, 'description')
      ? {
          description: pickPreparedHintValue(
            options,
            merchantChallengeMetadata,
            'description',
          ),
        }
      : {}),
    ...(pickPreparedHintValue(options, merchantChallengeMetadata, 'requestBodyType')
      ? {
          requestBodyType: pickPreparedHintValue(
            options,
            merchantChallengeMetadata,
            'requestBodyType',
          ),
        }
      : {}),
    ...(pickPreparedHintValue(options, merchantChallengeMetadata, 'requestBodyExample')
      ? {
          requestBodyExample: pickPreparedHintValue(
            options,
            merchantChallengeMetadata,
            'requestBodyExample',
          ),
        }
      : {}),
    requestBodyFields: mergePreparedHintFields(
      options,
      merchantChallengeMetadata,
      'requestBodyFields',
    ),
    requestQueryParams: mergePreparedHintFields(
      options,
      merchantChallengeMetadata,
      'requestQueryParams',
    ),
    requestPathParams: mergePreparedHintFields(
      options,
      merchantChallengeMetadata,
      'requestPathParams',
    ),
    notes: [
      ...(merchantChallengeMetadata?.notes ?? []).map((value) => ({
        value,
        attribution: createPreparationAttribution('merchant_challenge', 'authoritative'),
      })),
      ...(externalMetadata?.notes ?? []).map((value) => ({
        value,
        attribution: createPreparationAttribution('external_metadata', 'advisory'),
      })),
    ],
  };
}

function isJsonContentType(value: string | undefined) {
  return value?.toLowerCase().includes('application/json') ?? false;
}

function matchesExpectedFieldType(value: unknown, expectedType: string | undefined) {
  switch (expectedType?.toLowerCase()) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function buildPreparedValidationIssues(
  request: ReturnType<typeof createPreparedHttpRequest>,
  hints: SdkPreparedRequestHints,
): SdkPreparedValidationIssue[] {
  // Validation is intentionally narrow: it checks only request-shape issues the
  // SDK can defend from available hints, not task-specific semantic correctness.
  const issues: SdkPreparedValidationIssue[] = [];
  const contentType = request.headers?.['content-type'];
  const requestBodyType = hints.requestBodyType?.value.toLowerCase();
  const requiredBodyFields = hints.requestBodyFields.filter((field) => field.required);

  if (
    requestBodyType === 'json'
    && request.body !== undefined
    && !isJsonContentType(contentType)
  ) {
    issues.push({
      location: 'headers',
      field: 'content-type',
      code: 'unsupported_content_type',
      message:
        'Request body is expected to be JSON but content-type is not application/json.',
      source: hints.requestBodyType?.attribution.source ?? 'external_metadata',
      blocking: true,
      severity: 'error',
      suggestedFix: 'Send the request with content-type: application/json.',
    });
  }

  if (hints.requestBodyFields.length > 0) {
    if (request.body === undefined) {
      for (const field of requiredBodyFields) {
        issues.push({
          location: 'body',
          field: field.name,
          code: 'missing_required_field',
          message: `Required request body field "${field.name}" is missing.`,
          source: field.attribution.source,
          blocking: true,
          severity: 'error',
          suggestedFix: `Add the required body field "${field.name}" before execution.`,
        });
      }
    } else {
      const parsedBody = tryParseJson(request.body);

      if (parsedBody === undefined) {
        issues.push({
          location: 'body',
          field: 'body',
          code: 'malformed_candidate_value',
          message:
            'Request body must be valid JSON to satisfy the declared body fields.',
          source:
            hints.requestBodyType?.attribution.source
            ?? hints.requestBodyFields[0]?.attribution.source
            ?? 'external_metadata',
          blocking: true,
          severity: 'error',
          suggestedFix:
            'Send a valid JSON object body that satisfies the declared fields.',
        });
      } else if (!isRecord(parsedBody)) {
        issues.push({
          location: 'body',
          field: 'body',
          code: 'request_shape_conflicts_with_hint',
          message:
            'Request body must be a JSON object to satisfy the declared body fields.',
          source:
            hints.requestBodyFields[0]?.attribution.source
            ?? hints.requestBodyType?.attribution.source
            ?? 'external_metadata',
          blocking: true,
          severity: 'error',
          suggestedFix:
            'Send a JSON object body whose keys match the declared fields.',
        });
      } else {
        for (const field of requiredBodyFields) {
          if (!(field.name in parsedBody)) {
            issues.push({
              location: 'body',
              field: field.name,
              code: 'missing_required_field',
              message: `Required request body field "${field.name}" is missing.`,
              source: field.attribution.source,
              blocking: true,
              severity: 'error',
              suggestedFix: `Add the required body field "${field.name}" before execution.`,
            });
          }
        }

        for (const field of hints.requestBodyFields) {
          if (!(field.name in parsedBody)) {
            continue;
          }

          if (!matchesExpectedFieldType(parsedBody[field.name], field.type)) {
            issues.push({
              location: 'body',
              field: field.name,
              code: 'malformed_candidate_value',
              message: `Request body field "${field.name}" does not match the expected type${field.type ? ` "${field.type}"` : ''}.`,
              source: field.attribution.source,
              blocking: true,
              severity: 'error',
              suggestedFix: `Set "${field.name}" to a value compatible with the declared type${field.type ? ` "${field.type}"` : ''}.`,
            });
          }
        }
      }
    }
  }

  const url = new URL(request.url);

  for (const field of hints.requestQueryParams.filter((entry) => entry.required)) {
    if (!url.searchParams.has(field.name)) {
      issues.push({
        location: 'query',
        field: field.name,
        code: 'missing_required_query_param',
        message: `Required query parameter "${field.name}" is missing.`,
        source: field.attribution.source,
        blocking: true,
        severity: 'error',
        suggestedFix: `Add the required query parameter "${field.name}" before execution.`,
      });
    }
  }

  for (const field of hints.requestPathParams.filter((entry) => entry.required)) {
    if (
      url.pathname.includes(`{${field.name}}`)
      || url.pathname.includes(`:${field.name}`)
    ) {
      issues.push({
        location: 'path',
        field: field.name,
        code: 'missing_required_path_param',
        message: `Required path parameter "${field.name}" is still unresolved in the request URL.`,
        source: field.attribution.source,
        blocking: true,
        severity: 'error',
        suggestedFix:
          `Replace the unresolved path placeholder for "${field.name}" before execution.`,
      });
    }
  }

  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = [
      issue.location,
      issue.field.toLowerCase(),
      issue.code,
      issue.source,
    ].join(':');

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function derivePreparedNextAction(
  kind: SdkPreparedPaidRequest['kind'],
  validationIssues: SdkPreparedValidationIssue[],
): SdkPreparedNextAction {
  if (kind === 'passthrough') {
    return 'treat_as_passthrough';
  }

  if (validationIssues.some((issue) => issue.blocking)) {
    return 'revise_request';
  }

  return 'execute';
}

function readStringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIntegerValue(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function readPrecisionFromAmount(amount: string | undefined) {
  if (!amount) {
    return undefined;
  }

  const [, fractionalPart = ''] = amount.split('.');
  return fractionalPart.length;
}

function formatMinorUnitsAsAmount(amountMinor: string, precision: number) {
  if (precision === 0) {
    return amountMinor;
  }

  const normalizedMinor = amountMinor.replace(/^0+(?=\d)/, '') || '0';
  const paddedMinor = normalizedMinor.padStart(precision + 1, '0');
  const wholePart = paddedMinor.slice(0, -precision) || '0';
  const fractionalPart = paddedMinor.slice(-precision);

  return `${wholePart}.${fractionalPart}`;
}

function tryParsePaymentRequiredHeader(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
  } catch {
    // Fall through.
  }

  return tryParseJson(value);
}

function unwrapChallengePayload(payload: unknown) {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (isRecord(payload.challenge)) {
    return payload.challenge;
  }

  return payload;
}

function parseAuthenticateHeaderParameters(header: string | undefined) {
  if (!header) {
    return new Map<string, string>();
  }

  const matches = header.matchAll(/([a-zA-Z0-9_-]+)="([^"]+)"/g);
  const parameters = new Map<string, string>();

  for (const match of matches) {
    const [, key, value] = match;

    if (key && value) {
      parameters.set(key.toLowerCase(), value);
    }
  }

  return parameters;
}

function buildPreparedPaymentRequirement(
  challenge: DetectedChallenge,
): SdkPreparedPaymentRequirement | undefined {
  // Payment terms are normalized into one portable structure so callers do not
  // need protocol-specific parsing logic in their agent or application layer.
  const provenance = createPreparationAttribution(
    'merchant_challenge',
    'authoritative',
  );
  const paymentRequiredPayload = tryParsePaymentRequiredHeader(
    challenge.headers['payment-required'],
  );
  const payload = unwrapChallengePayload(paymentRequiredPayload ?? challenge.body);

  if (isRecord(payload)) {
    const resource = isRecord(payload.resource) ? payload.resource : undefined;
    const accepts = Array.isArray(payload.accepts) ? payload.accepts : undefined;
    const primaryAccept = accepts?.find((candidate) => isRecord(candidate));

    if (primaryAccept && isRecord(primaryAccept)) {
      const amountMinor = readStringValue(primaryAccept.amount)
        ?? readStringValue(primaryAccept.maxAmountRequired);
      const precision = readIntegerValue(primaryAccept.precision)
        ?? (isRecord(primaryAccept.extra)
          ? readIntegerValue(primaryAccept.extra.precision)
            ?? readIntegerValue(primaryAccept.extra.decimals)
          : undefined);
      const amount = amountMinor && precision !== undefined
        ? formatMinorUnitsAsAmount(amountMinor, precision)
        : undefined;

      return {
        protocol: challenge.protocol,
        ...(readStringValue(resource?.description)
          ? { description: readStringValue(resource?.description) }
          : {}),
        ...(readStringValue(primaryAccept.asset)
          ? { asset: readStringValue(primaryAccept.asset) }
          : {}),
        ...(readStringValue(primaryAccept.network)
          ? { network: readStringValue(primaryAccept.network) }
          : {}),
        ...(readStringValue(primaryAccept.payTo)
          ? { payee: readStringValue(primaryAccept.payTo) }
          : {}),
        ...(readStringValue(primaryAccept.amount)
          ? { amountType: 'exact' as const }
          : readStringValue(primaryAccept.maxAmountRequired)
            ? { amountType: 'max' as const }
            : {}),
        ...(amount ? { amount } : {}),
        ...(amountMinor ? { amountMinor } : {}),
        ...(precision !== undefined ? { precision } : {}),
        provenance,
      };
    }
  }

  const explicitAmount = readStringValue(challenge.headers['x-payment-amount']);
  const explicitPrecision = readIntegerValue(challenge.headers['x-payment-precision'])
    ?? readPrecisionFromAmount(explicitAmount);

  if (explicitAmount || challenge.headers['www-authenticate']) {
    const authenticateParameters = parseAuthenticateHeaderParameters(
      challenge.headers['www-authenticate'],
    );
    const amount = explicitAmount ?? authenticateParameters.get('amount');
    const precision = explicitPrecision ?? readPrecisionFromAmount(amount);
    const asset = readStringValue(challenge.headers['x-payment-asset'])
      ?? authenticateParameters.get('asset');
    const payee = readStringValue(challenge.headers['x-payment-payee'])
      ?? authenticateParameters.get('payee');
    const network = readStringValue(challenge.headers['x-payment-network'])
      ?? authenticateParameters.get('network');
    const amountMinor = amount && precision !== undefined
      ? monetaryAmountToMinorUnits(amount, precision)
      : undefined;

    return {
      protocol: challenge.protocol,
      ...(asset ? { asset } : {}),
      ...(network ? { network } : {}),
      ...(payee ? { payee } : {}),
      ...(amount ? { amount } : {}),
      ...(amountMinor ? { amountMinor } : {}),
      ...(precision !== undefined ? { precision } : {}),
      ...(amount ? { amountType: 'exact' as const } : {}),
      provenance,
    };
  }

  return {
    protocol: challenge.protocol,
    provenance,
  };
}

/**
 * Client bound to one organization/agent identity and one 402flow control plane.
 *
 * Most integrations either call fetchPaid() directly or use the explicit
 * preparePaidRequest() -> executePreparedRequest() flow.
 */
export class AgentPayClient {
  private readonly controlPlaneBaseUrl: string;
  private readonly auth: AgentPayAuth;
  private readonly identity: AgentPayClientIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string> | undefined;
  private cachedRuntimeToken: CachedRuntimeToken | undefined;
  private pendingRuntimeToken: Promise<string> | undefined;

  constructor(options: AgentPayClientOptions) {
    this.controlPlaneBaseUrl = trimTrailingSlash(options.controlPlaneBaseUrl);
    this.auth = options.auth;
    this.identity = {
      organization: options.organization,
      agent: options.agent,
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers;
  }

  /**
   * Probe or reuse a merchant challenge and return a normalized preparation
   * result the caller can inspect before paying.
   */
  async preparePaidRequest(
    input: string,
    init: RequestInit = {},
    options: PreparePaidRequestOptions = {},
  ): Promise<SdkPreparedPaidRequest> {
    const request = createPreparedHttpRequest(input, init);

    if (options.challenge) {
      const hints = await buildPreparedRequestHints(options, this.fetchImpl, options.challenge);
      const validationIssues = buildPreparedValidationIssues(request, hints);

      return {
        kind: 'ready',
        protocol: options.challenge.protocol,
        request,
        challenge: paidRequestChallengeSchema.parse(options.challenge),
        ...(buildPreparedPaymentRequirement(options.challenge)
          ? {
              paymentRequirement: buildPreparedPaymentRequirement(options.challenge),
            }
          : {}),
        hints,
        validationIssues,
        nextAction: derivePreparedNextAction('ready', validationIssues),
      };
    }

    const initialResponse = await this.fetchImpl(input, init);
    const challenge = await detectChallengeFromResponse(initialResponse);
    const probe = {
      responseStatus: initialResponse.status,
      confirmedAt: new Date().toISOString(),
    };
    const hints = await buildPreparedRequestHints(options, this.fetchImpl, challenge);
    const validationIssues = buildPreparedValidationIssues(request, hints);

    if (!challenge) {
      return {
        kind: 'passthrough',
        protocol: 'none',
        request,
        hints,
        probe,
        validationIssues,
        nextAction: derivePreparedNextAction('passthrough', validationIssues),
      };
    }

    return {
      kind: 'ready',
      protocol: challenge.protocol,
      request,
      challenge: paidRequestChallengeSchema.parse(challenge),
      ...(buildPreparedPaymentRequirement(challenge)
        ? { paymentRequirement: buildPreparedPaymentRequirement(challenge) }
        : {}),
      hints,
      probe,
      validationIssues,
      nextAction: derivePreparedNextAction('ready', validationIssues),
    };
  }

  /**
   * Execute the exact request that was previously prepared, without re-probing
   * the merchant first.
   */
  async executePreparedRequest(
    prepared: SdkPreparedPaidRequestReady,
    request: ExecutePreparedRequest = {},
  ): Promise<PaidResponse> {
    return this.fetchPaid(
      prepared.request.url,
      {
        method: prepared.request.method,
        ...(prepared.request.headers ? { headers: prepared.request.headers } : {}),
        ...(prepared.request.body !== undefined ? { body: prepared.request.body } : {}),
      },
      {
        ...request,
        challenge: prepared.challenge as DetectedChallenge,
      },
    );
  }

  /**
   * Fast-path helper that probes when needed, asks the control plane for a paid
   * execution decision, and returns either passthrough or success. All non-success
   * paid outcomes are thrown as FetchPaidError.
   */
  async fetchPaid(
    input: string,
    init: RequestInit = {},
    request: FetchPaidRequest,
  ): Promise<PaidResponse> {
    let challenge = request.challenge;

    if (!challenge) {
      const initialResponse = await this.fetchImpl(input, init);
      challenge = await detectChallengeFromResponse(initialResponse);

      if (!challenge) {
        return {
          kind: 'passthrough',
          protocol: 'none',
          response: initialResponse,
        };
      }
    }

    const decisionRequest = this.createDecisionRequest(
      input,
      init,
      request,
      challenge,
    );
    const decision = await this.requestPaymentDecision(
      decisionRequest,
      challenge.protocol,
    );

    return this.mapDecisionToPaidResponse(decision, challenge.protocol);
  }

  /** Lookup a durable receipt by id through the control plane. */
  async lookupReceipt(receiptId: string): Promise<SdkReceiptResponse> {
    const response = await this.controlPlaneFetch(
      `/api/sdk/receipts/${receiptId}`,
      {
        method: 'GET',
      },
      await this.getRuntimeAuthorizationHeader(),
    );

    if (!response.ok) {
      const error = await readControlPlaneError(
        response,
        `Receipt lookup failed with status ${response.status}.`,
      );

      throw new Error(error.message);
    }

    return sdkReceiptResponseSchema.parse(await response.json());
  }

  private createDecisionRequest(
    input: string,
    init: RequestInit,
    request: FetchPaidRequest,
    challenge: DetectedChallenge,
  ) {
    const {
      challenge: _challenge,
      idempotencyKey,
      ...requestContext
    } = request;

    return sdkPaymentDecisionRequestSchema.parse({
      context: {
        ...this.identity,
        ...requestContext,
      },
      request: createPreparedHttpRequest(input, init),
      challenge: {
        protocol: challenge.protocol,
        headers: challenge.headers,
        ...(challenge.body !== undefined ? { body: challenge.body } : {}),
      },
      idempotencyKey,
    });
  }

  private async requestPaymentDecision(
    decisionRequest: ReturnType<typeof sdkPaymentDecisionRequestSchema.parse>,
    protocol: PaidProtocol,
  ) {
    // The control plane is the single source of truth for payment policy and
    // receipt persistence. Any response that does not match the SDK contract is
    // downgraded to request_failed.
    const decisionResponse = await this.controlPlaneFetch(
      '/api/sdk/payment-decisions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(decisionRequest),
      },
      await this.getRuntimeAuthorizationHeader(),
    );

    const responseBody = await decisionResponse.text();
    const parsedBody = tryParseJson(responseBody);

    if (parsedBody !== undefined) {
      try {
        return sdkPaymentDecisionResponseSchema.parse(parsedBody);
      } catch {
        // Fall through to request-failed handling below.
      }
    }

    if (!decisionResponse.ok) {
      throw new FetchPaidError<RequestFailedPaidResponse>({
        kind: 'request_failed',
        protocol,
        response: createRawResponse(
          decisionResponse.status,
          responseBody,
          decisionResponse.headers,
        ),
        reason: getControlPlaneErrorMessage(
          parsedBody,
          `Payment decision failed with status ${decisionResponse.status}.`,
        ),
        decision: {
          outcome: 'request_failed',
          status: decisionResponse.status,
          message: getControlPlaneErrorMessage(
            parsedBody,
            `Payment decision failed with status ${decisionResponse.status}.`,
          ),
          ...(parsedBody !== undefined ? { body: parsedBody } : {}),
        },
      });
    }

    throw new FetchPaidError<RequestFailedPaidResponse>({
      kind: 'request_failed',
      protocol,
      response: createRawResponse(
        decisionResponse.status,
        responseBody,
        decisionResponse.headers,
      ),
      reason: 'Payment decision response did not match the SDK contract.',
      decision: {
        outcome: 'request_failed',
        status: decisionResponse.status,
        message: 'Payment decision response did not match the SDK contract.',
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      },
    });
  }

  private mapDecisionToPaidResponse(
    decision: SdkPaymentDecisionResponse,
    protocol: PaidProtocol,
  ): PaidResponse {
    // Only allow returns normally. Every other durable or non-durable paid outcome
    // is surfaced as a typed FetchPaidError so caller control flow stays explicit.
    switch (decision.outcome) {
      case 'allow': {
        const response: SuccessPaidResponse = {
          kind: 'success',
          protocol,
          response: createMerchantResponse(decision.merchantResponse),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          receiptId: decision.receipt.receiptId,
          receipt: decision.receipt,
        };

        return response;
      }
      case 'paid_fulfillment_failed': {
        const response: PaidFulfillmentFailedResponse = {
          kind: 'paid_fulfillment_failed',
          protocol,
          response: createMerchantResponse(decision.merchantResponse),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          receiptId: decision.receipt.receiptId,
          receipt: decision.receipt,
          reason: decision.reason,
          decision,
        };

        throw new FetchPaidError(response);
      }
      case 'deny': {
        const response: DeniedPaidResponse = {
          kind: 'denied',
          protocol,
          response: createJsonResponse(403, decision),
          reason: decision.reason,
          decision,
          ...(decision.paidRequestId
            ? { paidRequestId: decision.paidRequestId }
            : {}),
          ...(decision.policyReviewEventId
            ? { policyReviewEventId: decision.policyReviewEventId }
            : {}),
        };

        throw new FetchPaidError(response);
      }
      case 'executing': {
        const response: ExecutionPendingPaidResponse = {
          kind: 'execution_pending',
          protocol,
          response: createJsonResponse(202, decision),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          reason: decision.reason,
          decision,
        };

        throw new FetchPaidError(response);
      }
      case 'inconclusive': {
        const response: ExecutionInconclusivePaidResponse = {
          kind: 'execution_inconclusive',
          protocol,
          response: createJsonResponse(202, decision),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          reason: decision.reason,
          decision,
        };

        throw new FetchPaidError(response);
      }
      case 'execution_failed': {
        const response: ExecutionFailedPaidResponse = {
          kind: 'execution_failed',
          protocol,
          response: createMerchantResponse(decision.merchantResponse),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          reason: decision.reason,
          decision,
        };

        throw new FetchPaidError(response);
      }
      case 'preflight_failed': {
        const response: PreflightFailedPaidResponse = {
          kind: 'preflight_failed',
          protocol,
          response: createJsonResponse(502, decision),
          paidRequestId: decision.paidRequestId,
          paymentAttemptId: decision.paymentAttemptId,
          reason: decision.reason,
          decision,
        };

        throw new FetchPaidError(response);
      }
    }
  }

  private async getRuntimeAuthorizationHeader() {
    const runtimeToken = await this.resolveRuntimeToken();

    return `Bearer ${runtimeToken}`;
  }

  private async resolveRuntimeToken() {
    if (this.auth.type === 'runtimeToken') {
      return this.auth.runtimeToken;
    }

    if (this.cachedRuntimeToken) {
      const expiresInMs = this.cachedRuntimeToken.expiresAtMs - Date.now();

      if (expiresInMs > defaultRuntimeTokenRefreshWindowMs) {
        return this.cachedRuntimeToken.token;
      }
    }

    if (!this.pendingRuntimeToken) {
      this.pendingRuntimeToken = this.requestRuntimeToken();
    }

    try {
      return await this.pendingRuntimeToken;
    } finally {
      this.pendingRuntimeToken = undefined;
    }
  }

  private async requestRuntimeToken() {
    if (this.auth.type !== 'bootstrapKey') {
      throw new Error('Runtime token exchange requires bootstrapKey auth.');
    }

    const response = await this.controlPlaneFetch(
      '/api/sdk/runtime-tokens',
      {
        method: 'POST',
      },
      `Bearer ${this.auth.bootstrapKey}`,
    );

    if (!response.ok) {
      const error = await readControlPlaneError(
        response,
        `Runtime token exchange failed with status ${response.status}.`,
      );

      throw new Error(error.message);
    }

    const runtimeToken = parseRuntimeTokenResponse(await response.json());

    this.cachedRuntimeToken = {
      token: runtimeToken.token,
      expiresAtMs: Date.parse(runtimeToken.expiresAt),
    };

    return runtimeToken.token;
  }

  private async controlPlaneFetch(
    path: string,
    init: RequestInit,
    authorizationHeader: string,
  ) {
    // Every control-plane call carries the SDK version header so incompatible
    // client/server contract mismatches can fail fast.
    return this.fetchImpl(`${this.controlPlaneBaseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.headers ?? {}),
        ...(normalizeHeaders(init.headers) ?? {}),
        Authorization: authorizationHeader,
        [sdkClientVersionHeaderName]: sdkClientVersion,
      },
    });
  }
}

/** Small factory wrapper for callers that prefer a function export. */
export function createAgentPayClient(options: AgentPayClientOptions) {
  return new AgentPayClient(options);
}

export * from './agent-harness.js';
export * from './contracts.js';
export { detectChallengeFromResponse, type DetectedChallenge } from './challenge-detection.js';
export { sdkClientVersion, sdkClientVersionHeaderName } from './version.js';
