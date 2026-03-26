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
  'payment_execution_in_progress',
  'preflight_incompatible',
  'merchant_rejected',
  'settlement_proof_conflict',
  'merchant_transport_lost',
  'payment_rail_missing',
  'payment_rail_wrong_organization',
  'payment_rail_disabled',
  'payment_rail_incompatible',
]);
export type PaidRequestReasonCode = z.infer<typeof paidRequestReasonCodeSchema>;

const externalIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const decimalAmountPattern = /^\d+(?:\.\d+)?$/;
const minorUnitAmountPattern = /^\d+$/;
const currencyCodePattern = /^(?:[A-Z0-9_-]{3,10}|0x[a-fA-F0-9]{40})$/;
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

export const paidRequestContextSchema = z.object({
  organization: externalIdSchema,
  agent: externalIdSchema,
  description: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type PaidRequestContext = z.infer<typeof paidRequestContextSchema>;

export const paidRequestPaymentRailSchema = externalIdSchema;
export type PaidRequestPaymentRail = z.infer<typeof paidRequestPaymentRailSchema>;

export const paidRequestHttpRequestSchema = z.object({
  url: z.string().url(),
  method: paidRequestHttpMethodSchema,
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  bodyHash: z.string().min(1).max(128).optional(),
});
export type PaidRequestHttpRequest = z.infer<typeof paidRequestHttpRequestSchema>;

export const paidRequestChallengeSchema = z.object({
  protocol: paidRequestProtocolSchema,
  money: normalizedMoneySchema,
  payee: z.string().min(1).max(255).optional(),
  memo: z.string().min(1).max(500).optional(),
  raw: z.record(z.unknown()).default({}),
});
export type PaidRequestChallenge = z.infer<typeof paidRequestChallengeSchema>;

export const sdkPaymentDecisionRequestSchema = z.object({
  context: paidRequestContextSchema,
  request: paidRequestHttpRequestSchema,
  challenge: paidRequestChallengeSchema,
  paymentRail: paidRequestPaymentRailSchema.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type SdkPaymentDecisionRequest = z.infer<
  typeof sdkPaymentDecisionRequestSchema
>;

export const sdkReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  organizationId: z.string().uuid(),
  agentId: z.string().uuid(),
  merchantId: z.string().uuid(),
  protocol: paidRequestProtocolSchema,
  money: normalizedMoneySchema,
  authorizationOutcome: receiptAuthorizationOutcomeSchema,
  status: receiptStatusSchema,
  reconciliationStatus: receiptReconciliationStatusSchema,
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

export const sdkPaymentDecisionPaidFulfillmentFailedResponseSchema = z.object({
  outcome: z.literal('paid_fulfillment_failed'),
  paidRequestId: z.string().uuid(),
  paymentAttemptId: z.string().uuid(),
  reasonCode: z.literal('merchant_rejected'),
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
  reasonCode: z.literal('merchant_rejected'),
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

export const sdkReceiptResponseSchema = z.object({
  receipt: sdkReceiptSchema,
});
export type SdkReceiptResponse = z.infer<typeof sdkReceiptResponseSchema>;