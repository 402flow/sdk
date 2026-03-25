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
  type PaidRequestTarget,
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

export type AgentPayClientOptions = {
  controlPlaneBaseUrl: string;
  auth: AgentPayAuth;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export type FetchPaidOptions = {
  target: PaidRequestTarget;
  challenge?: ParsedChallenge;
  idempotencyKey?: string;
};

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

export type PaidResponse =
  | PassthroughPaidResponse
  | SuccessPaidResponse
  | PaidFulfillmentFailedResponse
  | DeniedPaidResponse
  | ExecutionPendingPaidResponse
  | ExecutionInconclusivePaidResponse
  | ExecutionFailedPaidResponse
  | PreflightFailedPaidResponse;

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
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string> | undefined;
  private cachedRuntimeToken: CachedRuntimeToken | undefined;
  private pendingRuntimeToken: Promise<string> | undefined;

  constructor(options: AgentPayClientOptions) {
    this.controlPlaneBaseUrl = trimTrailingSlash(options.controlPlaneBaseUrl);
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers;
  }

  async fetchPaid(
    input: string,
    init: RequestInit = {},
    context: PaidRequestContext,
    options: FetchPaidOptions,
  ): Promise<PaidResponse> {
    let challenge = options.challenge;

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

    const decisionRequest = await this.createDecisionRequest(
      input,
      init,
      context,
      options,
      challenge,
    );
    const decision = await this.requestPaymentDecision(decisionRequest);

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

  private async createDecisionRequest(
    input: string,
    init: RequestInit,
    context: PaidRequestContext,
    options: FetchPaidOptions,
    challenge: ParsedChallenge,
  ) {
    const requestBody = getReplayableRequestBody(init.body);

    return sdkPaymentDecisionRequestSchema.parse({
      context,
      target: options.target,
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
      idempotencyKey: options.idempotencyKey,
    });
  }

  private async requestPaymentDecision(
    decisionRequest: ReturnType<typeof sdkPaymentDecisionRequestSchema.parse>,
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

    try {
      return sdkPaymentDecisionResponseSchema.parse(JSON.parse(responseBody));
    } catch {
      if (!decisionResponse.ok) {
        throw new Error(
          `Payment decision failed with status ${decisionResponse.status}.`,
        );
      }

      throw new Error('Payment decision response was not valid JSON.');
    }
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

        return response;
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

        return response;
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

        return response;
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

        return response;
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

        return response;
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

        return response;
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
