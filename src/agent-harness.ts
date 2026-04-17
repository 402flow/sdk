/**
 * AgentHarness provides a small in-memory orchestration layer on top of
 * AgentPayClient for hosts that prefer preparedId-based handoffs over holding
 * full prepared request objects.
 *
 * The intended host-facing flow is:
 *
 * 1. prepare a candidate request and receive a preparedId plus the preparation summary
 * 2. execute later by preparedId once nextAction is execute
 * 3. read back the stored execution result by preparedId
 *
 * This is useful for tool-driven hosts such as OpenAI tools, MCP servers,
 * Claude tools, LangGraph nodes, or custom orchestrators where passing a small
 * opaque id between turns is easier than preserving the full prepared object.
 *
 * This file implements only a convenience layer. The core SDK contract remains
 * AgentPayClient with preparePaidRequest() and executePreparedRequest().
 *
 * Important behavior:
 * - State is kept only in memory inside this process.
 * - Prepared requests expire after a TTL.
 * - A newer active preparation for the same method + origin + pathname supersedes
 *   the older one.
 * - Execution is rejected locally unless the stored preparation is still active,
 *   kind === 'ready', and nextAction === 'execute'.
 */

import { randomUUID } from 'node:crypto';

import type {
  PaidRequestChallenge,
  SdkExternalMetadata,
  SdkMerchantResponse,
  SdkPreparedChallengeDetails,
  SdkPreparedNextAction,
  SdkPreparedPaidRequest,
  SdkPreparedPaidRequestReady,
  SdkPreparedPaymentRequirement,
  SdkPreparedRequestHints,
  SdkPreparedValidationIssue,
} from './contracts.js';
import type {
  AgentPayClient,
  ExecutePreparedRequest,
  FetchPaidFailureResponse,
  PaidResponse,
} from './index.js';

export type AgentHarnessPreparedState =
  | 'active'
  | 'consumed'
  | 'expired'
  | 'superseded';

/** Local rejection reasons produced by the harness before the SDK is called. */
export type AgentHarnessRejectionCode =
  | 'missing_prepared_id'
  | 'unknown_prepared_id'
  | 'expired_prepared_id'
  | 'prepared_request_superseded'
  | 'prepared_request_consumed'
  | 'prepared_request_not_ready'
  | 'prepared_request_not_executable';

/** Typed error used internally to convert local state failures into stable results. */
export class AgentHarnessError extends Error {
  readonly code: AgentHarnessRejectionCode;
  readonly preparedId: string | undefined;

  constructor(
    code: AgentHarnessRejectionCode,
    message: string,
    preparedId?: string,
  ) {
    super(message);
    this.name = 'AgentHarnessError';
    this.code = code;
    this.preparedId = preparedId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Host-facing input for the harness prepare step. */
export type AgentHarnessPrepareInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  externalMetadata?: SdkExternalMetadata;
};

/** Host-facing input for the harness execute step. */
export type AgentHarnessExecuteInput = {
  preparedId: string;
  executionContext?: ExecutePreparedRequest;
};

/** Exact immutable execution payload stored behind a preparedId. */
export type AgentHarnessExecutionBinding = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyHash?: string;
  challenge?: {
    protocol: PaidRequestChallenge['protocol'];
    headers: Record<string, string>;
    body?: unknown;
  };
  merchantOrigin: string;
};

/** Summary returned to the host after preparation succeeds. */
export type AgentHarnessPreparedSummary = {
  preparedId: string;
  state: 'active';
  kind: SdkPreparedPaidRequest['kind'];
  protocol: SdkPreparedPaidRequest['protocol'];
  challengeDetails?: SdkPreparedChallengeDetails;
  paymentRequirement?: SdkPreparedPaymentRequirement;
  hints: SdkPreparedRequestHints;
  probe?: SdkPreparedPaidRequest['probe'];
  validationIssues: SdkPreparedValidationIssue[];
  nextAction: SdkPreparedNextAction;
  expiresAt: string;
};

/** Stored summary for an SDK-backed paid execution outcome. */
export type AgentHarnessExecutedResult = {
  preparedId: string;
  harnessDisposition: 'executed';
  sdkOutcomeKind: PaidResponse['kind'] | FetchPaidFailureResponse['kind'];
  status: number;
  merchantResponse: SdkMerchantResponse;
  receiptId?: string;
  paidRequestId?: string;
  paymentAttemptId?: string;
  reason?: string;
  policyReviewEventId?: string;
};

/** Stored summary for a harness-local rejection outcome. */
export type AgentHarnessRejectedResult = {
  preparedId: string;
  harnessDisposition: 'rejected';
  rejectionCode: AgentHarnessRejectionCode;
  message: string;
};

export type AgentHarnessExecutionResult =
  | AgentHarnessExecutedResult
  | AgentHarnessRejectedResult;

/** Lookup shape returned when a host asks for the durable result of a preparedId. */
export type AgentHarnessExecutionLookup = {
  preparedId: string;
  state: AgentHarnessPreparedState;
  supersededByPreparedId?: string;
  executionResult?: AgentHarnessExecutionResult;
};

/** Full internal record shape exposed for debugging and test inspection. */
export type AgentHarnessPreparedRecord = {
  preparedId: string;
  state: AgentHarnessPreparedState;
  createdAt: string;
  expiresAt: string;
  supersededByPreparedId?: string;
  prepared: SdkPreparedPaidRequest;
  executionBinding: AgentHarnessExecutionBinding;
  executionResult?: AgentHarnessExecutionResult;
};

/** Minimal client surface AgentHarness needs from the core SDK. */
export type AgentHarnessClient = Pick<
  AgentPayClient,
  'preparePaidRequest' | 'executePreparedRequest'
>;

/** Configuration for the in-memory wrapper, including TTL and id generation hooks. */
export type AgentHarnessOptions = {
  client: AgentHarnessClient;
  preparedTtlMs?: number;
  now?: () => Date;
  createPreparedId?: () => string;
};

const defaultPreparedTtlMs = 5 * 60 * 1000;

type StoredPreparedRecord = {
  preparedId: string;
  state: AgentHarnessPreparedState;
  createdAt: string;
  expiresAt: string;
  supersededByPreparedId?: string;
  prepared: SdkPreparedPaidRequest;
  executionBinding: AgentHarnessExecutionBinding;
  executionResult?: AgentHarnessExecutionResult;
};

// Preparations supersede by stable execution target, not by full query/body, so a
// newer attempt for the same endpoint path invalidates older active ones.
function createSupersessionKey(binding: AgentHarnessExecutionBinding) {
  const url = new URL(binding.url);

  return `${binding.method}:${url.origin}${url.pathname}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
  } else {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }

  return Object.freeze(value);
}

// All records exposed back to callers are cloned and frozen so host code cannot
// mutate the harness' in-memory state by retaining object references.
function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function createFrozenClone<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};

  if (!headers) {
    return normalizedHeaders;
  }

  const headerMap = new Headers(headers);
  headerMap.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  return normalizedHeaders;
}

function buildExecutionBinding(
  prepared: SdkPreparedPaidRequest,
): AgentHarnessExecutionBinding {
  // Capture the exact prepared execution payload once so later execute calls do
  // not depend on the host resending or reconstructing it correctly.
  return createFrozenClone({
    method: prepared.request.method,
    url: prepared.request.url,
    headers: normalizeHeaders(prepared.request.headers),
    ...(prepared.request.body !== undefined ? { body: prepared.request.body } : {}),
    ...(prepared.request.bodyHash !== undefined
      ? { bodyHash: prepared.request.bodyHash }
      : {}),
    ...(prepared.kind === 'ready'
      ? {
          challenge: {
            protocol: prepared.challenge.protocol,
            headers: normalizeHeaders(prepared.challenge.headers),
            ...(prepared.challenge.body !== undefined
              ? { body: cloneValue(prepared.challenge.body) }
              : {}),
          },
        }
      : {}),
    merchantOrigin: new URL(prepared.request.url).origin,
  });
}

function summarizePreparedRecord(
  record: StoredPreparedRecord,
): AgentHarnessPreparedSummary {
  return cloneValue({
    preparedId: record.preparedId,
    state: 'active' as const,
    kind: record.prepared.kind,
    protocol: record.prepared.protocol,
    ...(record.prepared.kind === 'ready' && record.prepared.challengeDetails
      ? { challengeDetails: record.prepared.challengeDetails }
      : {}),
    ...(record.prepared.kind === 'ready' && record.prepared.paymentRequirement
      ? { paymentRequirement: record.prepared.paymentRequirement }
      : {}),
    hints: record.prepared.hints,
    ...(record.prepared.probe ? { probe: record.prepared.probe } : {}),
    validationIssues: record.prepared.validationIssues,
    nextAction: record.prepared.nextAction,
    expiresAt: record.expiresAt,
  });
}

async function summarizeMerchantResponse(
  response: Response,
): Promise<SdkMerchantResponse> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body: await response.clone().text(),
  };
}

async function summarizeExecutionOutcome(
  preparedId: string,
  outcome: PaidResponse | FetchPaidFailureResponse,
): Promise<AgentHarnessExecutedResult> {
  return {
    preparedId,
    harnessDisposition: 'executed',
    sdkOutcomeKind: outcome.kind,
    status: outcome.response.status,
    merchantResponse: await summarizeMerchantResponse(outcome.response),
    ...('receiptId' in outcome && outcome.receiptId
      ? { receiptId: outcome.receiptId }
      : {}),
    ...('paidRequestId' in outcome && outcome.paidRequestId
      ? { paidRequestId: outcome.paidRequestId }
      : {}),
    ...('paymentAttemptId' in outcome && outcome.paymentAttemptId
      ? { paymentAttemptId: outcome.paymentAttemptId }
      : {}),
    ...('reason' in outcome && typeof outcome.reason === 'string'
      ? { reason: outcome.reason }
      : {}),
    ...('policyReviewEventId' in outcome && outcome.policyReviewEventId
      ? { policyReviewEventId: outcome.policyReviewEventId }
      : {}),
  };
}

function isFetchPaidFailureResponse(value: unknown): value is FetchPaidFailureResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.kind === 'string' &&
    typeof candidate.protocol === 'string' &&
    candidate.response instanceof Response &&
    typeof candidate.reason === 'string' &&
    typeof candidate.decision === 'object' &&
    candidate.decision !== null
  );
}

function isFetchPaidErrorLike(
  error: unknown,
): error is { details: FetchPaidFailureResponse } {
  if (!(error instanceof Error) || error.name !== 'FetchPaidError') {
    return false;
  }

  const candidate = error as Error & { details?: unknown };
  return isFetchPaidFailureResponse(candidate.details);
}

/**
 * Optional in-memory preparedId wrapper over AgentPayClient.
 */
export class AgentHarness {
  private readonly client: AgentHarnessClient;
  private readonly preparedTtlMs: number;
  private readonly now: () => Date;
  private readonly createPreparedId: () => string;
  private readonly preparedRecords = new Map<string, StoredPreparedRecord>();

  constructor(options: AgentHarnessOptions) {
    this.client = options.client;
    this.preparedTtlMs = options.preparedTtlMs ?? defaultPreparedTtlMs;
    this.now = options.now ?? (() => new Date());
    this.createPreparedId = options.createPreparedId ?? (() => randomUUID());
  }

  /**
   * Prepare a candidate request through the core SDK and store the immutable
   * prepared result behind a generated preparedId for later execution.
   */
  async preparePaidRequest(
    input: AgentHarnessPrepareInput,
  ): Promise<AgentHarnessPreparedSummary> {
    // Prepare against the SDK, then store the exact prepared request behind a
    // deterministic id so later tool calls do not need to resend the full payload.
    const prepared = await this.client.preparePaidRequest(
      input.url,
      {
        ...(input.method ? { method: input.method } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
      {
        ...(input.externalMetadata
          ? { externalMetadata: input.externalMetadata }
          : {}),
      },
    );

    const createdAt = this.now();
    const preparedId = this.createPreparedId();
    const record: StoredPreparedRecord = {
      preparedId,
      state: 'active',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.preparedTtlMs).toISOString(),
      prepared: createFrozenClone(prepared),
      executionBinding: buildExecutionBinding(prepared),
    };

    this.supersedeActiveRecords(record);

    this.preparedRecords.set(preparedId, record);

    return summarizePreparedRecord(record);
  }

  /**
   * Execute a previously stored ready preparation. Local state failures are
   * converted into deterministic rejected results rather than thrown to the host.
   */
  async executePreparedRequest(
    input: AgentHarnessExecuteInput,
  ): Promise<AgentHarnessExecutionResult> {
    try {
      // Execution is only allowed for active, ready preparations. All rejected
      // local states are converted into stored deterministic results.
      const record = this.getRecordForExecution(input.preparedId);
      const outcome = await this.runExecution(record, input.executionContext);

      record.state = 'consumed';
      record.executionResult = createFrozenClone(outcome);

      return cloneValue(outcome);
    } catch (error) {
      if (!(error instanceof AgentHarnessError)) {
        throw error;
      }

      return this.handleExecutionRejection(input.preparedId, error);
    }
  }

  /**
   * Return the durable stored outcome for a preparedId without re-running any
   * merchant or control-plane call.
   */
  getExecutionResult(
    preparedId: string,
  ): AgentHarnessExecutionLookup {
    // This lookup lets an agent fetch the durable outcome later without re-running
    // execution or depending on host-specific tool memory.
    const record = this.getKnownRecord(preparedId);
    this.refreshRecordState(record);

    return cloneValue({
      preparedId: record.preparedId,
      state: record.state,
      ...(record.supersededByPreparedId
        ? { supersededByPreparedId: record.supersededByPreparedId }
        : {}),
      ...(record.executionResult
        ? { executionResult: record.executionResult }
        : {}),
    });
  }

  /**
   * Return the full stored record for debugging, tests, or host inspection.
   */
  getPreparedRecord(preparedId: string): AgentHarnessPreparedRecord {
    const record = this.getKnownRecord(preparedId);
    this.refreshRecordState(record);

    return cloneValue({
      preparedId: record.preparedId,
      state: record.state,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.supersededByPreparedId
        ? { supersededByPreparedId: record.supersededByPreparedId }
        : {}),
      prepared: record.prepared,
      executionBinding: record.executionBinding,
      ...(record.executionResult
        ? { executionResult: record.executionResult }
        : {}),
    });
  }

  private async runExecution(
    record: StoredPreparedRecord,
    executionContext: ExecutePreparedRequest | undefined,
  ): Promise<AgentHarnessExecutedResult> {
    try {
      const response = await this.client.executePreparedRequest(
        record.prepared as SdkPreparedPaidRequestReady,
        executionContext,
      );

      return summarizeExecutionOutcome(record.preparedId, response);
    } catch (error) {
      if (!isFetchPaidErrorLike(error)) {
        throw error;
      }

      return summarizeExecutionOutcome(record.preparedId, error.details);
    }
  }

  // Rejection results are stored so later lookups remain deterministic even when
  // execution never reached the core SDK or merchant.
  private handleExecutionRejection(
    preparedId: string,
    error: AgentHarnessError,
  ): AgentHarnessRejectedResult {
    const rejectedResult: AgentHarnessRejectedResult = {
      preparedId,
      harnessDisposition: 'rejected',
      rejectionCode: error.code,
      message: error.message,
    };

    const record = preparedId ? this.preparedRecords.get(preparedId) : undefined;
    if (
      record &&
      error.code !== 'prepared_request_consumed' &&
      !record.executionResult
    ) {
      record.executionResult = createFrozenClone(rejectedResult);
    }

    return rejectedResult;
  }

  private getRecordForExecution(preparedId: string): StoredPreparedRecord {
    const record = this.getKnownRecord(preparedId);
    this.refreshRecordState(record);

    if (record.state === 'expired') {
      throw new AgentHarnessError(
        'expired_prepared_id',
        `Prepared request ${preparedId} has expired.`,
        preparedId,
      );
    }

    if (record.state === 'superseded') {
      throw new AgentHarnessError(
        'prepared_request_superseded',
        record.supersededByPreparedId
          ? `Prepared request ${preparedId} was superseded by ${record.supersededByPreparedId}.`
          : `Prepared request ${preparedId} was superseded by a newer preparation.`,
        preparedId,
      );
    }

    if (record.state === 'consumed') {
      throw new AgentHarnessError(
        'prepared_request_consumed',
        `Prepared request ${preparedId} has already been consumed.`,
        preparedId,
      );
    }

    if (record.prepared.kind !== 'ready') {
      throw new AgentHarnessError(
        'prepared_request_not_ready',
        `Prepared request ${preparedId} is not executable because it is ${record.prepared.kind}.`,
        preparedId,
      );
    }

    if (record.prepared.nextAction !== 'execute') {
      throw new AgentHarnessError(
        'prepared_request_not_executable',
        `Prepared request ${preparedId} requires ${record.prepared.nextAction} before execution.`,
        preparedId,
      );
    }

    return record;
  }

  private getKnownRecord(preparedId: string): StoredPreparedRecord {
    if (preparedId.trim().length === 0) {
      throw new AgentHarnessError(
        'missing_prepared_id',
        'A preparedId is required.',
      );
    }

    const record = this.preparedRecords.get(preparedId);
    if (!record) {
      throw new AgentHarnessError(
        'unknown_prepared_id',
        `Prepared request ${preparedId} is unknown.`,
        preparedId,
      );
    }

    return record;
  }

  // Expiry is checked lazily on access so the harness does not need timers or a
  // background cleanup loop.
  private refreshRecordState(record: StoredPreparedRecord) {
    if (record.state !== 'active') {
      return;
    }

    if (this.now().getTime() >= new Date(record.expiresAt).getTime()) {
      record.state = 'expired';
    }
  }

  private supersedeActiveRecords(nextRecord: StoredPreparedRecord) {
    // Only one active preparation should survive for the same method + origin +
    // pathname. Older active preparations become stale as soon as a newer one is stored.
    const nextKey = createSupersessionKey(nextRecord.executionBinding);

    for (const record of this.preparedRecords.values()) {
      if (record.state !== 'active') {
        continue;
      }

      if (createSupersessionKey(record.executionBinding) !== nextKey) {
        continue;
      }

      record.state = 'superseded';
      record.supersededByPreparedId = nextRecord.preparedId;
    }
  }
}