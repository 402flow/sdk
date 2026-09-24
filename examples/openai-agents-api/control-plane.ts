import { z } from 'zod';
import { sdkClientVersionHeaderName, sdkClientVersion } from '@402flow/sdk';
import {
  controlPlaneBaseUrl,
  paymentAsset,
  merchantUrl,
  type PaidRequestConfig,
  type PaidRequestOutcome,
  type PaidRequestIdentity,
} from './paid-request-contract.js';
import { ProbeError, requestText } from './transport.js';
const uuid = z.string().uuid();
const record = z.record(z.unknown());
export class ControlPlaneClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly secrets: string[] = [],
  ) {}
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const response = await requestText(
      this.fetchImpl,
      `${controlPlaneBaseUrl}/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          [sdkClientVersionHeaderName]: sdkClientVersion,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      30_000,
      1_048_576,
    );
    if (
      [this.token, ...this.secrets].some(
        (secret) => secret && response.text.includes(secret),
      )
    )
      throw new ProbeError('paid_request_secret_reflected');
    if (!response.ok)
      throw new ProbeError(`paid_request_control_plane_http_${response.status}`);
    return response.text ? JSON.parse(response.text) : {};
  }
}
export const orgPath = (c: PaidRequestConfig) =>
  `/organizations/${c.organizationId}`;
export const agentPath = (c: PaidRequestConfig) =>
  `${orgPath(c)}/agents/${c.agentId}`;
export async function preflightPaidRequest(
  api: ControlPlaneClient,
  c: PaidRequestConfig,
): Promise<{
  identity: PaidRequestIdentity;
  posture: string;
  requestPolicyRevisionId: string;
  budgetPolicyRevisionId: string;
  walletId: string;
  paymentConnectionId: string;
}> {
  const org = z
    .object({
      organization: z.object({
        id: uuid,
        externalId: z.string(),
        governancePosture: z.string(),
        archivedAt: z.string().optional(),
      }),
    })
    .parse(await api.request(orgPath(c))).organization;
  const agent = z
    .object({
      agent: z.object({
        id: uuid,
        organizationId: uuid,
        externalId: z.string(),
        status: z.literal('enabled'),
        lifecycleStatus: z.literal('active'),
      }),
    })
    .parse(await api.request(agentPath(c))).agent;
  if (
    org.id !== c.organizationId ||
    org.archivedAt ||
    agent.id !== c.agentId ||
    agent.organizationId !== c.organizationId
  )
    throw new ProbeError('paid_request_identity_not_ready');
  // A caller may already have a bootstrap key without its original issue-response
  // ID. Authentication validates that key; the new runtime session supplies its
  // authoritative credential ID before any capability reaches the hosted agent.
  if (c.credentialId) {
    const credential = z
      .object({
        credential: z.object({
          id: uuid,
          agentId: uuid,
          organizationId: uuid,
          status: z.literal('active'),
          expiresAt: z.string().datetime().optional(),
          revokedAt: z.string().optional(),
        }),
      })
      .parse(
        await api.request(
          `${agentPath(c)}/bootstrap-credentials/${c.credentialId}`,
        ),
      ).credential;
    if (
      credential.id !== c.credentialId ||
      credential.agentId !== c.agentId ||
      credential.organizationId !== c.organizationId ||
      credential.revokedAt ||
      (credential.expiresAt &&
        Date.parse(credential.expiresAt) <= Date.now() + 360_000)
    )
      throw new ProbeError('paid_request_identity_not_ready');
  }
  const policyResponseSchema = z
    .object({
      policy: z.object({
        id: uuid,
        organizationId: uuid,
        currentRevisionId: uuid,
        enabled: z.literal(true),
        lifecycleStatus: z.literal('active'),
        definition: z.object({
          metric: z.literal('amount'),
          basis: z.enum(['per_request', 'aggregate_over_time']),
          window: z.enum(['none', 'day', 'week', 'month']),
          scopeKind: z.literal('agents'),
          populationMode: z.literal('selected'),
          agentIds: z.array(uuid).length(1),
          applicationMode: z.literal('per_member'),
          maxAmount: z.object({
            asset: z.literal('USDC'),
            amountMinor: z.string().regex(/^\d+$/),
            precision: z.literal(6),
          }),
        }),
      }),
    });
  const readPolicy = async (id: string) => {
    const policy = policyResponseSchema.parse(
      await api.request(`${orgPath(c)}/policies/${id}`),
    ).policy;
    if (
      policy.id !== id ||
      policy.organizationId !== c.organizationId ||
      policy.definition.agentIds[0] !== c.agentId
    )
      throw new ProbeError('paid_request_policy_scope_mismatch');
    return policy;
  };
  const requestPolicy = await readPolicy(c.requestPolicyId);
  if (
    requestPolicy.definition.basis !== 'per_request' ||
    requestPolicy.definition.window !== 'none' ||
    BigInt(requestPolicy.definition.maxAmount.amountMinor) > BigInt(c.maxAmountMinor)
  )
    throw new ProbeError('paid_request_request_policy_mismatch');
  const budgetPolicy = await readPolicy(c.budgetPolicyId);
  if (
    budgetPolicy.definition.basis !== 'aggregate_over_time' ||
    budgetPolicy.definition.window !== 'day' ||
    BigInt(budgetPolicy.definition.maxAmount.amountMinor) > BigInt(c.maxBudgetAmountMinor)
  )
    throw new ProbeError('paid_request_budget_policy_mismatch');
  const connections = z
    .object({
      paymentRails: z.array(
        z.object({
          id: uuid,
          organizationId: uuid,
          type: z.string(),
          status: z.string(),
          lifecycleStatus: z.string(),
          config: record,
        }),
      ),
    })
    .parse(await api.request(`${orgPath(c)}/payment-connections`));
  const enabled = connections.paymentRails.filter(
    (v) =>
      v.organizationId === c.organizationId &&
      v.type === 'x402' &&
      v.status === 'enabled' &&
      v.lifecycleStatus === 'active' &&
      ['base-sepolia', 'eip155:84532'].includes(String(v.config.network)),
  );
  if (enabled.length !== 1)
    throw new ProbeError('paid_request_payment_connection_not_ready');
  const coverage = z
    .object({
      paymentRailCoverage: z.array(
        z.object({
          protocol: z.string(),
          network: z.string(),
          asset: z.string(),
          coverageStatus: z.string(),
          compatibleEnabledWallets: z.array(z.object({ walletId: uuid })),
          activeWallet: z.object({ walletId: uuid }).optional(),
        }),
      ),
    })
    .parse(await api.request(`${orgPath(c)}/wallets/coverage`));
  const eligible = coverage.paymentRailCoverage.filter(
    (v) =>
      v.protocol === 'x402' &&
      v.network === 'base-sepolia' &&
      v.asset === 'usdc',
  );
  const row = eligible[0];
  if (
    eligible.length !== 1 ||
    row?.coverageStatus !== 'ready' ||
    row.compatibleEnabledWallets.length !== 1 ||
    row.activeWallet?.walletId !== row.compatibleEnabledWallets[0]?.walletId
  )
    throw new ProbeError('paid_request_wallet_coverage_not_ready');
  return {
    identity: { organization: org.externalId, agent: agent.externalId },
    posture: org.governancePosture,
    requestPolicyRevisionId: requestPolicy.currentRevisionId,
    budgetPolicyRevisionId: budgetPolicy.currentRevisionId,
    walletId: row.activeWallet!.walletId,
    paymentConnectionId: enabled[0]!.id,
  };
}
const runtimeSchema = z.object({
  id: uuid,
  organizationId: uuid,
  agentId: uuid,
  credentialId: uuid,
  status: z.string(),
  scope: z.array(z.string()),
  expiresAt: z.string().datetime(),
});
export async function runtimeSessions(
  api: ControlPlaneClient,
  c: PaidRequestConfig,
) {
  return z
    .object({ runtimeSessions: z.array(runtimeSchema) })
    .parse(
      await api.request(
        `${agentPath(c)}/runtime-sessions${c.credentialId ? `?credentialId=${c.credentialId}` : ''}`,
      ),
    ).runtimeSessions;
}
export async function exchangeRuntimeToken(
  bootstrap: string,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await requestText(
    fetchImpl,
    `${controlPlaneBaseUrl}/api/sdk/runtime-tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrap}`,
        [sdkClientVersionHeaderName]: sdkClientVersion,
      },
    },
    30_000,
    16_384,
  );
  if (!response.ok || response.text.includes(bootstrap))
    throw new ProbeError('paid_request_runtime_exchange_failed');
  return z
    .object({ token: z.string().min(1), expiresAt: z.string().datetime() })
    .parse(JSON.parse(response.text));
}
export async function revokeRuntimeSession(
  api: ControlPlaneClient,
  c: PaidRequestConfig,
  id: string,
  credentialId = c.credentialId,
) {
  uuid.parse(id);
  const path = `${agentPath(c)}/runtime-sessions/${id}`;
  const before = z
    .object({ runtimeSession: runtimeSchema })
    .parse(await api.request(path)).runtimeSession;
  if (
    before.id !== id ||
    before.organizationId !== c.organizationId ||
    before.agentId !== c.agentId ||
    (credentialId !== undefined && before.credentialId !== credentialId)
  )
    throw new ProbeError('paid_request_runtime_identity_mismatch');
  if (before.status === 'revoked') return;
  const after = z.object({ runtimeSession: runtimeSchema }).parse(
    await api.request(`${path}/revoke`, 'POST', {
      reason: 'OpenAI Agents API Paid request example cleanup',
    }),
  ).runtimeSession;
  if (after.id !== id || after.status !== 'revoked')
    throw new ProbeError('paid_request_runtime_revoke_unconfirmed');
}
export async function verifyPaymentEvidence(
  api: ControlPlaneClient,
  c: PaidRequestConfig,
  outcome: PaidRequestOutcome,
  runtimeId: string,
  credentialId = c.credentialId,
) {
  uuid.parse(credentialId);
  if (!outcome.paidRequestId)
    throw new ProbeError('paid_request_missing_paid_request_id');
  const paid = z
    .object({ paidRequest: record })
    .parse(
      await api.request(`${orgPath(c)}/paid-requests/${outcome.paidRequestId}`),
    ).paidRequest;
  if (
    paid.id !== outcome.paidRequestId ||
    paid.organizationId !== c.organizationId ||
    paid.agentId !== c.agentId
  )
    throw new ProbeError('paid_request_paid_identity_mismatch');
  const lineage = z.object({ runtimeSessionId: uuid, credentialId: uuid });
  const checkLineage = (item: Record<string, unknown>) => {
    const auth = lineage.safeParse(item.authContext);
    if (
      !auth.success ||
      auth.data.runtimeSessionId !== runtimeId ||
      auth.data.credentialId !== credentialId
    )
      throw new ProbeError('paid_request_auth_lineage_mismatch');
  };
  const checkMoney = (item: Record<string, unknown>) => {
    const money = z
      .object({
        asset: z.literal(paymentAsset),
        precision: z.literal(6),
        amountMinor: z.string().regex(/^[1-9]\d*$/),
      })
      .parse(item.money);
    if (BigInt(money.amountMinor) > BigInt(c.maxAmountMinor))
      throw new ProbeError('paid_request_evidence_amount_mismatch');
    return money.amountMinor;
  };
  checkLineage(paid);
  const amount = checkMoney(paid);
  if (
    paid.idempotencyKey !== `openai-agents-paid-request:${c.operationId}` ||
    paid.requestUrl !== merchantUrl ||
    paid.requestMethod !== 'POST' ||
    paid.protocol !== 'x402'
  )
    throw new ProbeError('paid_request_operation_binding_mismatch');
  const audits = z
    .object({
      auditEvents: z.array(
        z.object({
          id: uuid,
          organizationId: uuid,
          paidRequestId: uuid.optional(),
          receiptId: uuid.optional(),
          paymentAttemptId: uuid.optional(),
          eventType: z.string(),
          payload: record,
        }),
      ),
    })
    .parse(
      await api.request(
        `${orgPath(c)}/audit-events?paidRequestId=${outcome.paidRequestId}`,
      ),
    ).auditEvents;
  const matching = audits.filter(
    (a) =>
      a.organizationId === c.organizationId &&
      a.paidRequestId === outcome.paidRequestId &&
      a.payload.runtimeSessionId === runtimeId &&
      a.payload.credentialId === credentialId &&
      a.payload.agentId === c.agentId &&
      a.payload.idempotencyKey === `openai-agents-paid-request:${c.operationId}`,
  );
  const required =
    c.expectedOutcome === 'success'
      ? 'sdk.payment_execution.succeeded'
      : c.expectedOutcome === 'review'
        ? 'sdk.payment_decision.policy_review_required'
        : 'sdk.payment_decision.denied';
  if (!matching.some((a) => a.eventType === required))
    throw new ProbeError('paid_request_audit_lineage_mismatch');
  if (c.expectedOutcome === 'success') {
    if (
      outcome.kind !== 'success' ||
      outcome.responseStatus !== 200 ||
      !outcome.receiptVerified ||
      !outcome.receiptId ||
      !outcome.paymentAttemptId
    )
      throw new ProbeError('paid_request_expected_success');
    const receipt = z
      .object({ receipt: record })
      .parse(
        await api.request(`${orgPath(c)}/receipts/${outcome.receiptId}`),
      ).receipt;
    const attempt = z
      .object({ paymentAttempt: record })
      .parse(
        await api.request(
          `${orgPath(c)}/payment-attempts/${outcome.paymentAttemptId}`,
        ),
      ).paymentAttempt;
    for (const item of [receipt, attempt]) {
      if (
        item.organizationId !== c.organizationId ||
        item.agentId !== c.agentId ||
        item.paidRequestId !== outcome.paidRequestId
      )
        throw new ProbeError('paid_request_evidence_identity_mismatch');
    }
    for (const item of [receipt, attempt]) {
      checkLineage(item);
      if (checkMoney(item) !== amount)
        throw new ProbeError('paid_request_evidence_amount_mismatch');
      const method = z
        .object({
          protocol: z.literal('x402'),
          network: z.literal('base-sepolia'),
          asset: z.literal('usdc'),
        })
        .safeParse(item.supportedMethod);
      if (!method.success)
        throw new ProbeError('paid_request_evidence_network_mismatch');
    }
    if (
      !matching.some(
        (a) =>
          a.eventType === required &&
          a.receiptId === outcome.receiptId &&
          a.paymentAttemptId === outcome.paymentAttemptId,
      )
    )
      throw new ProbeError('paid_request_audit_lifecycle_mismatch');
    if (
      receipt.requestUrl !== merchantUrl ||
      receipt.requestMethod !== 'POST' ||
      receipt.authorizationOutcome !== 'allowed' ||
      receipt.fulfillmentStatus !== 'succeeded' ||
      receipt.settlementStatus !== 'confirmed'
    )
      throw new ProbeError('paid_request_receipt_not_confirmed');
    if (
      receipt.receiptId !== outcome.receiptId ||
      receipt.paymentAttemptId !== outcome.paymentAttemptId ||
      attempt.id !== outcome.paymentAttemptId ||
      attempt.receiptId !== outcome.receiptId ||
      attempt.status !== 'succeeded' ||
      receipt.evidenceSource === 'local_simulation'
    )
      throw new ProbeError('paid_request_receipt_attempt_mismatch');
  } else {
    if (
      outcome.kind !== 'denied' ||
      outcome.receiptId ||
      outcome.paymentAttemptId ||
      (c.expectedOutcome === 'review') !== Boolean(outcome.policyReviewEventId)
    )
      throw new ProbeError('paid_request_expected_denial');
    if (outcome.policyReviewEventId) {
      const review = z
        .object({ policyReviewEvent: record })
        .parse(
          await api.request(
            `${orgPath(c)}/policy-review-events/${outcome.policyReviewEventId}`,
          ),
        ).policyReviewEvent;
      if (
        review.id !== outcome.policyReviewEventId ||
        review.agentId !== c.agentId ||
        review.organizationId !== c.organizationId ||
        review.paidRequestId !== outcome.paidRequestId
      )
        throw new ProbeError('paid_request_review_identity_mismatch');
    }
    // Check actual lifecycle records as well as the model-visible response.
    const attempts = z
      .object({ paymentAttempts: z.array(record) })
      .parse(
        await api.request(`${orgPath(c)}/payment-attempts`),
      ).paymentAttempts;
    const receipts = z
      .object({ receipts: z.array(record) })
      .parse(await api.request(`${orgPath(c)}/receipts`)).receipts;
    if (
      [...attempts, ...receipts].some(
        (v) => v.paidRequestId === outcome.paidRequestId,
      )
    )
      throw new ProbeError('paid_request_denial_has_payment_evidence');
  }
  return { auditEventIds: matching.map((a) => a.id), verified: true as const };
}
