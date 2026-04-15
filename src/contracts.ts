/**
 * Public wire-contract schemas for @402flow/sdk.
 *
 * These schemas serve two roles:
 * 1. validate control-plane and merchant-facing data at runtime
 * 2. define the exported TypeScript shapes the SDK exposes to callers
 */
import { z } from 'zod';

export const receiptAuthorizationOutcomeSchema = z.enum(['allowed']);
export type ReceiptAuthorizationOutcome = z.infer<
  typeof receiptAuthorizationOutcomeSchema
>;

export const settlementEvidenceClassSchema = z.enum([
  'none',
  'inconclusive',
  'merchant_verifiable_success',
  'settled',
]);
export type SettlementEvidenceClass = z.infer<
  typeof settlementEvidenceClassSchema
>;

export const fulfillmentStatusSchema = z.enum([
  'succeeded',
  'failed',
  'inconclusive',
]);
export type FulfillmentStatus = z.infer<typeof fulfillmentStatusSchema>;

export const receiptStatusSchema = z.enum([
  'confirmed',
  'provisional',
  'expired_unconfirmed',
  'refunded',
  'void',
]);
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

export const receiptReconciliationStatusSchema = z.enum([
  'none',
  'required',
  'in_progress',
  'resolved',
  'refunded',
]);
export type ReceiptReconciliationStatus = z.infer<
  typeof receiptReconciliationStatusSchema
>;

export const paymentProofSourceSchema = z.enum(['merchant', 'local_simulation']);
export type PaymentProofSource = z.infer<typeof paymentProofSourceSchema>;

export const chainAttributionStrengthSchema = z.enum([
  'strong_request_scoped',
  'constrained_unique',
]);
export type ChainAttributionStrength = z.infer<
  typeof chainAttributionStrengthSchema
>;

export const chainConfirmationSourceSchema = z.enum(['chain_observer']);
export type ChainConfirmationSource = z.infer<
  typeof chainConfirmationSourceSchema
>;

export const chainFinalityLevelSchema = z.enum([
  'evm_block_confirmations_12',
]);
export type ChainFinalityLevel = z.infer<typeof chainFinalityLevelSchema>;

export const chainAttributionBasisSchema = z.record(z.unknown());
export type ChainAttributionBasis = z.infer<typeof chainAttributionBasisSchema>;

export const paidRequestProtocolSchema = z.enum(['x402', 'l402']);
export type PaidRequestProtocol = z.infer<typeof paidRequestProtocolSchema>;

export const paidRequestHttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type PaidRequestHttpMethod = z.infer<typeof paidRequestHttpMethodSchema>;

export const paidRequestReasonCodeSchema = z.enum([
  'policy_allow',
  'policy_denied',
  'policy_review_required',
  'challenge_candidate_malformed',
  'challenge_no_supported_candidates',
  'challenge_execution_identity_unavailable',
  'challenge_execution_identity_ambiguous',
  'payment_execution_in_progress',
  'preflight_incompatible',
  'merchant_rejected',
  'merchant_execution_failed',
  'settlement_proof_conflict',
  'merchant_transport_lost',
]);
export type PaidRequestReasonCode = z.infer<typeof paidRequestReasonCodeSchema>;

const externalIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const decimalAmountPattern = /^\d+(?:\.\d+)?$/;
const minorUnitAmountPattern = /^\d+$/;
const currencyCodePattern =
  /^(?:[A-Z0-9_-]{3,10}|0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
export const defaultMoneyPrecision = 6;

export const externalIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(externalIdPattern);

export const monetaryAmountSchema = z.string().regex(decimalAmountPattern);

export const currencyCodeSchema = z.string().regex(currencyCodePattern);

export const moneyUnitSchema = z.literal('minor');

function formatMonetaryAmount(amount: string, precision: number) {
  if (!decimalAmountPattern.test(amount)) {
    throw new Error('Invalid monetary amount format.');
  }

  const parts = amount.split('.');
  const wholePart = parts[0] ?? '0';
  const fractionalPart = parts[1] ?? '';

  if (fractionalPart.length > precision) {
    throw new Error('Monetary amount exceeds the declared precision.');
  }

  if (precision === 0) {
    return wholePart;
  }

  return `${wholePart}.${fractionalPart.padEnd(precision, '0')}`;
}

/**
 * Convert a decimal amount into minor units using the declared precision.
 * The SDK uses this when a merchant expresses payment terms in decimal form but
 * downstream contracts require canonical minor-unit amounts.
 */
export function monetaryAmountToMinorUnits(amount: string, precision: number) {
  const normalizedAmount = formatMonetaryAmount(amount, precision);

  if (precision === 0) {
    return normalizedAmount;
  }

  const parts = normalizedAmount.split('.');
  const wholePart = parts[0] ?? '0';
  const fractionalPart = parts[1] ?? '';
  const minorUnits = `${wholePart}${fractionalPart}`.replace(/^0+(?=\d)/, '');

  return minorUnits || '0';
}

/** Canonical normalized money shape used on receipts and payment requirements. */
export const normalizedMoneySchema = z
  .object({
    asset: currencyCodeSchema,
    amount: monetaryAmountSchema,
    amountMinor: z.string().regex(minorUnitAmountPattern),
    precision: z.number().int().min(0).max(defaultMoneyPrecision),
    unit: moneyUnitSchema,
  })
  .superRefine((value, context) => {
    try {
      const normalizedAmount = formatMonetaryAmount(
        value.amount,
        value.precision,
      );

      if (normalizedAmount !== value.amount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: 'Money amount must match the declared precision.',
        });
      }

      if (
        monetaryAmountToMinorUnits(value.amount, value.precision) !==
        value.amountMinor
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amountMinor'],
          message:
            'Money minor-unit amount must match the declared amount and precision.',
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message:
          error instanceof Error
            ? error.message
            : 'Invalid monetary amount provided.',
      });
    }
  });
export type NormalizedMoney = z.infer<typeof normalizedMoneySchema>;

/** Request-scoped context the control plane uses for policy, audit, and identity. */
export const paidRequestContextSchema = z.object({
  organization: externalIdSchema,
  agent: externalIdSchema,
  description: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type PaidRequestContext = z.infer<typeof paidRequestContextSchema>;

/** Exact HTTP request shape that gets prepared, hashed, and later executed. */
export const paidRequestHttpRequestSchema = z.object({
  url: z.string().url(),
  method: paidRequestHttpMethodSchema,
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  bodyHash: z.string().min(1).max(128).optional(),
});
export type PaidRequestHttpRequest = z.infer<typeof paidRequestHttpRequestSchema>;

/** Merchant challenge evidence captured during prepare or fetchPaid flows. */
export const paidRequestChallengeSchema = z.object({
  protocol: paidRequestProtocolSchema,
  headers: z.record(z.string()).default({}),
  body: z.unknown().optional(),
});
export type PaidRequestChallenge = z.infer<typeof paidRequestChallengeSchema>;

export const sdkPreparationSourceSchema = z.enum([
  'merchant_challenge',
  'external_metadata',
]);
export type SdkPreparationSource = z.infer<typeof sdkPreparationSourceSchema>;

export const sdkPreparationAuthoritySchema = z.enum([
  'authoritative',
  'advisory',
]);
export type SdkPreparationAuthority = z.infer<
  typeof sdkPreparationAuthoritySchema
>;

export const sdkPreparationAttributionSchema = z.object({
  source: sdkPreparationSourceSchema,
  authority: sdkPreparationAuthoritySchema,
  note: z.string().min(1).max(400).optional(),
});
export type SdkPreparationAttribution = z.infer<
  typeof sdkPreparationAttributionSchema
>;

export const sdkPreparationFieldSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().min(1).max(400).optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  enumValues: z.array(z.string().trim().min(1)).optional(),
});
export type SdkPreparationField = z.infer<typeof sdkPreparationFieldSchema>;

/** Optional caller-supplied metadata used to enrich preparation hints. */
export const sdkExternalMetadataSchema = z.object({
  description: z.string().trim().min(1).max(400).optional(),
  requestBodyType: z.string().trim().min(1).max(100).optional(),
  requestBodyExample: z.string().trim().min(1).max(20_000).optional(),
  requestBodyFields: z.array(sdkPreparationFieldSchema).optional(),
  requestQueryParams: z.array(sdkPreparationFieldSchema).optional(),
  requestPathParams: z.array(sdkPreparationFieldSchema).optional(),
  notes: z.array(z.string().trim().min(1).max(400)).optional(),
});
export type SdkExternalMetadata = z.infer<
  typeof sdkExternalMetadataSchema
>;

export const sdkPreparedHintValueSchema = z.object({
  value: z.string().min(1),
  attribution: sdkPreparationAttributionSchema,
});
export type SdkPreparedHintValue = z.infer<typeof sdkPreparedHintValueSchema>;

export const sdkPreparedHintFieldSchema = sdkPreparationFieldSchema.extend({
  attribution: sdkPreparationAttributionSchema,
});
export type SdkPreparedHintField = z.infer<typeof sdkPreparedHintFieldSchema>;

/**
 * Consolidated request-shape hints returned by preparePaidRequest(). Every hint
 * carries attribution so callers can distinguish advisory metadata from live
 * merchant-authoritative evidence.
 */
export const sdkPreparedRequestHintsSchema = z.object({
  description: sdkPreparedHintValueSchema.optional(),
  requestBodyType: sdkPreparedHintValueSchema.optional(),
  requestBodyExample: sdkPreparedHintValueSchema.optional(),
  requestBodyFields: z.array(sdkPreparedHintFieldSchema).default([]),
  requestQueryParams: z.array(sdkPreparedHintFieldSchema).default([]),
  requestPathParams: z.array(sdkPreparedHintFieldSchema).default([]),
  notes: z.array(sdkPreparedHintValueSchema).default([]),
});
export type SdkPreparedRequestHints = z.infer<
  typeof sdkPreparedRequestHintsSchema
>;

export const sdkPreparedPaymentRequirementAmountTypeSchema = z.enum([
  'exact',
  'max',
]);
export type SdkPreparedPaymentRequirementAmountType = z.infer<
  typeof sdkPreparedPaymentRequirementAmountTypeSchema
>;

/** Normalized payment terms extracted from a merchant challenge when available. */
export const sdkPreparedPaymentRequirementSchema = z.object({
  protocol: paidRequestProtocolSchema,
  description: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  network: z.string().min(1).optional(),
  payee: z.string().min(1).optional(),
  amountType: sdkPreparedPaymentRequirementAmountTypeSchema.optional(),
  amount: monetaryAmountSchema.optional(),
  amountMinor: z.string().regex(minorUnitAmountPattern).optional(),
  precision: z.number().int().min(0).max(defaultMoneyPrecision).optional(),
  provenance: sdkPreparationAttributionSchema,
});
export type SdkPreparedPaymentRequirement = z.infer<
  typeof sdkPreparedPaymentRequirementSchema
>;

/** Evidence that the SDK performed an unpaid live probe before preparation. */
export const sdkPreparedProbeResultSchema = z.object({
  responseStatus: z.number().int().min(100).max(599),
  confirmedAt: z.string().datetime(),
});
export type SdkPreparedProbeResult = z.infer<
  typeof sdkPreparedProbeResultSchema
>;

export const sdkPreparedValidationIssueLocationSchema = z.enum([
  'body',
  'query',
  'path',
  'headers',
]);
export type SdkPreparedValidationIssueLocation = z.infer<
  typeof sdkPreparedValidationIssueLocationSchema
>;

export const sdkPreparedValidationSeveritySchema = z.enum([
  'error',
  'warning',
]);
export type SdkPreparedValidationSeverity = z.infer<
  typeof sdkPreparedValidationSeveritySchema
>;

/** Structured remediation guidance derived from hints and the candidate request. */
export const sdkPreparedValidationIssueSchema = z.object({
  location: sdkPreparedValidationIssueLocationSchema,
  field: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(400),
  source: sdkPreparationSourceSchema,
  blocking: z.boolean(),
  severity: sdkPreparedValidationSeveritySchema,
  suggestedFix: z.string().trim().min(1).max(400).optional(),
});
export type SdkPreparedValidationIssue = z.infer<
  typeof sdkPreparedValidationIssueSchema
>;

/** Narrow action summary the caller should take after preparation. */
export const sdkPreparedNextActionSchema = z.enum([
  'execute',
  'revise_request',
  'treat_as_passthrough',
  'manual_review',
]);
export type SdkPreparedNextAction = z.infer<
  typeof sdkPreparedNextActionSchema
>;

/** Preparation result when this exact request does not currently require payment. */
export const sdkPreparedPaidRequestPassthroughSchema = z.object({
  kind: z.literal('passthrough'),
  protocol: z.literal('none'),
  request: paidRequestHttpRequestSchema,
  hints: sdkPreparedRequestHintsSchema,
  probe: sdkPreparedProbeResultSchema.optional(),
  validationIssues: z.array(sdkPreparedValidationIssueSchema).default([]),
  nextAction: sdkPreparedNextActionSchema,
});
export type SdkPreparedPaidRequestPassthrough = z.infer<
  typeof sdkPreparedPaidRequestPassthroughSchema
>;

/** Preparation result when this exact request is payable and executable. */
export const sdkPreparedPaidRequestReadySchema = z.object({
  kind: z.literal('ready'),
  protocol: paidRequestProtocolSchema,
  request: paidRequestHttpRequestSchema,
  challenge: paidRequestChallengeSchema,
  paymentRequirement: sdkPreparedPaymentRequirementSchema.optional(),
  hints: sdkPreparedRequestHintsSchema,
  probe: sdkPreparedProbeResultSchema.optional(),
  validationIssues: z.array(sdkPreparedValidationIssueSchema).default([]),
  nextAction: sdkPreparedNextActionSchema,
});
export type SdkPreparedPaidRequestReady = z.infer<
  typeof sdkPreparedPaidRequestReadySchema
>;

/** Discriminated union returned by AgentPayClient.preparePaidRequest(). */
export const sdkPreparedPaidRequestSchema = z.discriminatedUnion('kind', [
  sdkPreparedPaidRequestPassthroughSchema,
  sdkPreparedPaidRequestReadySchema,
]);
export type SdkPreparedPaidRequest = z.infer<
  typeof sdkPreparedPaidRequestSchema
>;

/** Control-plane request shape used for governed paid execution decisions. */
export const sdkPaymentDecisionRequestSchema = z.object({
  context: paidRequestContextSchema,
  request: paidRequestHttpRequestSchema,
  challenge: paidRequestChallengeSchema,
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type SdkPaymentDecisionRequest = z.infer<
  typeof sdkPaymentDecisionRequestSchema
>;

/** Durable receipt shape returned after the control plane records an outcome. */
export const sdkReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  organizationId: z.string().uuid(),
  agentId: z.string().uuid(),
  merchantId: z.string().uuid().optional(),
  protocol: paidRequestProtocolSchema,
  money: normalizedMoneySchema,
  authorizationOutcome: receiptAuthorizationOutcomeSchema,
  status: receiptStatusSchema,
  reconciliationStatus: receiptReconciliationStatusSchema,
  confirmationSource: chainConfirmationSourceSchema.optional(),
  attributionStrength: chainAttributionStrengthSchema.optional(),
  attributionBasis: chainAttributionBasisSchema.optional(),
  attributionRuleVersion: z.string().min(1).max(128).optional(),
  confirmedAt: z.string().datetime().optional(),
  finalityLevelUsed: chainFinalityLevelSchema.optional(),
  requestUrl: z.string().url(),
  requestMethod: paidRequestHttpMethodSchema,
  canonicalSettlementKey: z.string().min(1).max(255).optional(),
  paymentReference: z.string().min(1).max(128).optional(),
  evidenceSource: paymentProofSourceSchema.optional(),
  settlementEvidenceClass: settlementEvidenceClassSchema.optional(),
  settlementIdentifier: z.string().min(1).max(255).optional(),
  supersededByReceiptId: z.string().uuid().optional(),
  fulfillmentStatus: fulfillmentStatusSchema.optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type SdkReceipt = z.infer<typeof sdkReceiptSchema>;

/** Normalized merchant HTTP response embedded in SDK results and decisions. */
export const sdkMerchantResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()).default({}),
  body: z.string().default(''),
});
export type SdkMerchantResponse = z.infer<typeof sdkMerchantResponseSchema>;

export const sdkPaymentDecisionAllowResponseSchema = z.object({
  outcome: z.literal('allow'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: paidRequestReasonCodeSchema,
  reason: z.string().min(1),
  merchantResponse: sdkMerchantResponseSchema,
  receipt: sdkReceiptSchema,
});

const sdkMerchantFailureReasonCodeSchema = z.enum([
  'merchant_rejected',
  'merchant_execution_failed',
]);

export const sdkPaymentDecisionPaidFulfillmentFailedResponseSchema = z.object({
  outcome: z.literal('paid_fulfillment_failed'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: sdkMerchantFailureReasonCodeSchema,
  reason: z.string().min(1),
  merchantResponse: sdkMerchantResponseSchema,
  settlementEvidenceClass: settlementEvidenceClassSchema,
  fulfillmentStatus: z.literal('failed'),
  receipt: sdkReceiptSchema,
  evidence: z.record(z.unknown()).optional(),
});

export const sdkPaymentDecisionExecutionFailedResponseSchema = z.object({
  outcome: z.literal('execution_failed'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: sdkMerchantFailureReasonCodeSchema,
  reason: z.string().min(1),
  merchantResponse: sdkMerchantResponseSchema,
  evidence: z.record(z.unknown()).optional(),
});

export const sdkPaymentDecisionPreflightFailedResponseSchema = z.object({
  outcome: z.literal('preflight_failed'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: z.literal('preflight_incompatible'),
  reason: z.string().min(1),
  evidence: z.record(z.unknown()).optional(),
});

export const sdkPaymentDecisionExecutingResponseSchema = z.object({
  outcome: z.literal('executing'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: z.literal('payment_execution_in_progress'),
  reason: z.string().min(1),
});

export const sdkPaymentDecisionInconclusiveResponseSchema = z.object({
  outcome: z.literal('inconclusive'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: z.literal('merchant_transport_lost'),
  reason: z.string().min(1),
  evidence: z.record(z.unknown()).optional(),
});

export const sdkPaymentDecisionDenyResponseSchema = z.object({
  outcome: z.literal('deny'),
  paidRequestId: z.string().uuid().optional(),
  reasonCode: paidRequestReasonCodeSchema,
  reason: z.string().min(1),
  policyReviewEventId: z.string().uuid().optional(),
});

/** Full union of decision outcomes the control plane can return to the SDK. */
export const sdkPaymentDecisionResponseSchema = z.discriminatedUnion('outcome', [
  sdkPaymentDecisionAllowResponseSchema,
  sdkPaymentDecisionPaidFulfillmentFailedResponseSchema,
  sdkPaymentDecisionExecutingResponseSchema,
  sdkPaymentDecisionPreflightFailedResponseSchema,
  sdkPaymentDecisionExecutionFailedResponseSchema,
  sdkPaymentDecisionInconclusiveResponseSchema,
  sdkPaymentDecisionDenyResponseSchema,
]);
export type SdkPaymentDecisionResponse = z.infer<
  typeof sdkPaymentDecisionResponseSchema
>;

/** Receipt lookup response returned by AgentPayClient.lookupReceipt(). */
export const sdkReceiptResponseSchema = z.object({
  receipt: sdkReceiptSchema,
});
export type SdkReceiptResponse = z.infer<typeof sdkReceiptResponseSchema>;