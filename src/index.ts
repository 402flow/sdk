import { createHash } from 'node:crypto';

import {
  detectChallengeFromResponse,
  type ParsedChallenge,
} from './challenge-detection.js';
import {
  sdkPaymentDecisionRequestSchema,
  sdkPaymentDecisionResponseSchema,
  sdkReceiptResponseSchema,
  type PaidRequestContext,
  type SdkMerchantResponse,
  type SdkPaymentDecisionResponse,
  type SdkReceipt,
  type SdkReceiptResponse,
} from './contracts.js';

export type AgentPayAuth =
  | {
      type: 'bootstrapKey';
      bootstrapKey: string;
    }
  | {
      type: 'runtimeToken';
      runtimeToken: string;
    };

export type AgentPayClientIdentity = Pick<
  PaidRequestContext,
  'organization' | 'agent'
>;

export type AgentPayClientOptions = {
  controlPlaneBaseUrl: string;
  auth: AgentPayAuth;
  organization: string;
  agent: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export type FetchPaidOptions = {
  paymentRail?: string;
  challenge?: ParsedChallenge;
  idempotencyKey?: string;
};

export type FetchPaidRequest =
  Omit<PaidRequestContext, keyof AgentPayClientIdentity> & FetchPaidOptions;

type PaidProtocol = ParsedChallenge['protocol'];
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

export type PassthroughPaidResponse = PaidResponseBase & {
  kind: 'passthrough';
  protocol: 'none';
};

export type SuccessPaidResponse = PaidResponseBase & {
  kind: 'success';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  receiptId: string;
  receipt: SdkReceipt;
};

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

export type DeniedPaidResponse = PaidResponseBase & {
  kind: 'denied';
  protocol: PaidProtocol;
  paidRequestId?: string;
  reason: string;
  decision: DenyDecision;
  policyReviewEventId?: string;
};

export type ExecutionPendingPaidResponse = PaidResponseBase & {
  kind: 'execution_pending';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: ExecutingDecision;
};

export type ExecutionInconclusivePaidResponse = PaidResponseBase & {
  kind: 'execution_inconclusive';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: InconclusiveDecision;
};

export type ExecutionFailedPaidResponse = PaidResponseBase & {
  kind: 'execution_failed';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: ExecutionFailedDecision;
};

export type PreflightFailedPaidResponse = PaidResponseBase & {
  kind: 'preflight_failed';
  protocol: PaidProtocol;
  paidRequestId: string;
  paymentAttemptId: string;
  reason: string;
  decision: PreflightFailedDecision;
};

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

function getReplayableRequestBody(body: RequestInit['body']) {
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
    'Paid requests currently support replayable string and URLSearchParams bodies when routed through the control plane.',
  );
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

  async lookupReceipt(receiptId: string): Promise<SdkReceiptResponse> {
    const response = await this.controlPlaneFetch(
      `/api/sdk/receipts/${receiptId}`,
      {
        method: 'GET',
      },
      await this.getRuntimeAuthorizationHeader(),
    );

    if (!response.ok) {
      throw new Error(`Receipt lookup failed with status ${response.status}.`);
    }

    return sdkReceiptResponseSchema.parse(await response.json());
  }

  private createDecisionRequest(
    input: string,
    init: RequestInit,
    request: FetchPaidRequest,
    challenge: ParsedChallenge,
  ) {
    const requestBody = getReplayableRequestBody(init.body);
    const {
      challenge: _challenge,
      idempotencyKey,
      paymentRail,
      ...requestContext
    } = request;

    return sdkPaymentDecisionRequestSchema.parse({
      context: {
        ...this.identity,
        ...requestContext,
      },
      request: {
        url: input,
        method: (init.method ?? 'GET').toUpperCase(),
        headers: normalizeHeaders(init.headers),
        body: requestBody,
        bodyHash: hashRequestBody(requestBody),
      },
      challenge: {
        protocol: challenge.protocol,
        money: challenge.money,
        raw: challenge.raw,
        ...(challenge.payee ? { payee: challenge.payee } : {}),
      },
      ...(paymentRail ? { paymentRail } : {}),
      idempotencyKey,
    });
  }

  private async requestPaymentDecision(
    decisionRequest: ReturnType<typeof sdkPaymentDecisionRequestSchema.parse>,
    protocol: PaidProtocol,
  ) {
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
      throw new Error(
        `Runtime token exchange failed with status ${response.status}.`,
      );
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
    return this.fetchImpl(`${this.controlPlaneBaseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.headers ?? {}),
        ...(normalizeHeaders(init.headers) ?? {}),
        Authorization: authorizationHeader,
      },
    });
  }
}

export function createAgentPayClient(options: AgentPayClientOptions) {
  return new AgentPayClient(options);
}

export * from './contracts.js';
