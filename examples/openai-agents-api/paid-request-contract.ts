import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  sdkPreparedPaidRequestReadySchema,
  type SdkPreparedPaidRequestReady,
} from '@402flow/sdk';
import { ProbeError } from './transport.js';

export const controlPlaneBaseUrl = 'https://api-staging.402flow.ai';
export const merchantUrl =
  'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia';
export const paymentAsset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const requestBody = JSON.stringify({
  topic: 'OpenAI Agents API reference integration',
  audience: 'developers',
  format: 'bullets',
});
const minor = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .refine((v) => BigInt(v) <= 1000n);
export const paidRequestConfigSchema = z
  .object({
    operationId: z.string().uuid(),
    organizationId: z.string().uuid(),
    agentId: z.string().uuid(),
    credentialId: z.string().uuid().optional(),
    requestPolicyId: z.string().uuid(),
    budgetPolicyId: z.string().uuid(),
    model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
    expectedOutcome: z.enum(['success', 'denied', 'review']),
    maxAmountMinor: minor,
    maxBudgetAmountMinor: z.string().regex(/^[1-9]\d{0,17}$/),
  })
  .strict();
export type PaidRequestConfig = z.infer<typeof paidRequestConfigSchema>;
const identitySchema = z
  .object({
    organization: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    agent: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  })
  .strict();
export type PaidRequestIdentity = z.infer<typeof identitySchema>;
export const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    config: paidRequestConfigSchema,
    identity: identitySchema,
    prepared: z.custom<SdkPreparedPaidRequestReady>(
      (v) => sdkPreparedPaidRequestReadySchema.safeParse(v).success,
    ),
    context: z
      .object({
        idempotencyKey: z.string().regex(/^openai-agents-paid-request:[0-9a-f-]{36}$/),
        metadata: z
          .object({
            integration: z.literal('openai-agents-api-paid-request'),
            operationId: z.string().uuid(),
          })
          .strict(),
      })
      .strict(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PaidRequestCheckpoint = z.infer<typeof checkpointSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function validatePrepared(
  value: unknown,
  config: PaidRequestConfig,
): SdkPreparedPaidRequestReady {
  const p = sdkPreparedPaidRequestReadySchema.parse(value);
  const terms = p.challengeDetails?.accepts;
  const advertised = z.object({
    x402Version: z.literal(2),
    resource: z.object({ url: z.literal(merchantUrl) }),
    accepts: z
      .array(
        z.object({
          network: z.literal('eip155:84532'),
          asset: z.literal(paymentAsset),
          amount: minor,
          scheme: z.literal('exact'),
        }),
      )
      .length(1),
  });
  const header = p.challenge.headers['payment-required'];
  const challenge = advertised.parse(
    header
      ? JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      : p.challenge.body,
  );
  if (
    p.kind !== 'ready' ||
    p.nextAction !== 'execute' ||
    p.protocol !== 'x402' ||
    p.challenge.protocol !== 'x402' ||
    p.probe?.responseStatus !== 402 ||
    p.request.url !== merchantUrl ||
    p.request.method !== 'POST' ||
    p.request.body !== requestBody ||
    canonical(p.request.headers) !==
      canonical({ 'content-type': 'application/json' }) ||
    !terms ||
    terms.length !== 1 ||
    terms[0]?.network !== 'eip155:84532' ||
    terms[0]?.asset !== paymentAsset ||
    terms[0]?.amount !== challenge.accepts[0]?.amount ||
    BigInt(challenge.accepts[0]!.amount) > BigInt(config.maxAmountMinor) ||
    p.paymentRequirement?.amountMinor !== challenge.accepts[0]?.amount ||
    p.paymentRequirement?.network !== 'eip155:84532'
  ) {
    throw new ProbeError('paid_request_prepared_request_mismatch');
  }
  // Retain the original JSON exactly; schema parsing may strip fields/defaults.
  return value as SdkPreparedPaidRequestReady;
}
export function makeCheckpoint(
  config: PaidRequestConfig,
  identity: PaidRequestIdentity,
  prepared: unknown,
): PaidRequestCheckpoint {
  const payload = {
    schemaVersion: 1 as const,
    config: paidRequestConfigSchema.parse(config),
    identity: identitySchema.parse(identity),
    prepared: validatePrepared(prepared, config),
    context: {
      idempotencyKey: `openai-agents-paid-request:${config.operationId}`,
      metadata: {
        integration: 'openai-agents-api-paid-request' as const,
        operationId: config.operationId,
      },
    },
  };
  return checkpointSchema.parse({
    ...payload,
    fingerprint: digest(canonical(payload)),
  });
}
export function validateCheckpoint(value: unknown) {
  const checkpoint = checkpointSchema.parse(value);
  const { fingerprint, ...payload } = checkpoint;
  validatePrepared(checkpoint.prepared, checkpoint.config);
  if (
    fingerprint !== digest(canonical(payload)) ||
    checkpoint.context.idempotencyKey !==
      `openai-agents-paid-request:${checkpoint.config.operationId}` ||
    checkpoint.context.metadata.operationId !== checkpoint.config.operationId
  )
    throw new ProbeError('paid_request_checkpoint_mismatch');
  return checkpoint;
}
export const paidRequestOutcomeSchema = z
  .object({
    kind: z.enum([
      'success',
      'denied',
      'preflight_failed',
      'execution_pending',
      'execution_failed',
      'execution_inconclusive',
      'paid_fulfillment_failed',
      'request_failed',
    ]),
    paidRequestId: z.string().uuid().optional(),
    paymentAttemptId: z.string().uuid().optional(),
    receiptId: z.string().uuid().optional(),
    policyReviewEventId: z.string().uuid().optional(),
    responseStatus: z.number().int().optional(),
    bodySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    receiptVerified: z.boolean().optional(),
  })
  .strict();
export type PaidRequestOutcome = z.infer<typeof paidRequestOutcomeSchema>;
