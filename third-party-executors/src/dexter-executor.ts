/**
 * Dexter delegated-execution adapter for the repo-local third-party executors
 * package.
 *
 * This module stays outside the main @402flow/sdk package so provider-specific
 * SDK dependencies can evolve independently from the provider-neutral SDK core.
 */
import {
  getPaymentReceipt,
  payAndFetch,
  type PayAndFetchOptions,
  type PayResult,
  type WalletSet,
} from '@dexterai/x402/client';

import type {
  PreparedRequestExecutor,
  PreparedRequestExecutorInput,
  SdkDelegatedExecutionDiagnosticCode,
  SdkDelegatedExecutionResult,
  SdkDelegatedExecutionStatus,
  SdkDelegatedMerchantOutcome,
  SdkMerchantResponse,
  SdkPreparedPaidRequestReady,
  SettlementEvidenceClass,
} from '@402flow/sdk';

export type DexterExecutorOptions = {
  wallets: WalletSet;
  payAndFetchOptions?: PayAndFetchOptions;
};

export function createDexterExecutor(
  options: DexterExecutorOptions,
): PreparedRequestExecutor {
  return {
    provider: 'dexter',
    async execute(input) {
      const result = await payAndFetch(
        input.prepared.request.url,
        buildDexterRequestInit(input.prepared),
        options.wallets,
        options.payAndFetchOptions ?? {},
      );

      return mapDexterPayResult(input, result);
    },
  };
}

function buildDexterRequestInit(
  prepared: SdkPreparedPaidRequestReady,
): RequestInit {
  return {
    method: prepared.request.method,
    ...(prepared.request.headers ? { headers: prepared.request.headers } : {}),
    ...(prepared.request.body !== undefined ? { body: prepared.request.body } : {}),
  };
}

async function mapDexterPayResult(
  input: PreparedRequestExecutorInput,
  result: PayResult,
): Promise<SdkDelegatedExecutionResult> {
  const protocol = input.prepared.protocol;

  if (result.ok && result.paid) {
    const merchantResponse = result.response
      ? await toSdkMerchantResponse(result.response)
      : undefined;
    const paymentReceipt = result.response
      ? getPaymentReceipt(result.response)
      : undefined;
    const settlementReference = result.txSignature ?? paymentReceipt?.transaction;
    const signerSubmissionEvidence = settlementReference
      ? {
          txHash: settlementReference,
          paymentReference: settlementReference,
        }
      : undefined;

    if (merchantResponse) {
      return {
        protocol,
        executionStatus: 'succeeded',
        settlementEvidenceClass: 'merchant_verifiable_success',
        merchantOutcome: 'success_response',
        ...(settlementReference
          ? {
              settlementReference,
              paymentReference: settlementReference,
            }
          : {}),
        evidenceSource: settlementReference ? 'merchant' : undefined,
        ...(signerSubmissionEvidence ? { signerSubmissionEvidence } : {}),
        merchantResponse,
        protocolArtifacts: buildDexterProtocolArtifacts(result, paymentReceipt),
      };
    }

    return {
      protocol,
      executionStatus: 'inconclusive',
      settlementEvidenceClass: 'settled',
      merchantOutcome: 'no_response',
      ...(settlementReference
        ? {
            settlementReference,
            paymentReference: settlementReference,
          }
        : {}),
      ...(signerSubmissionEvidence ? { signerSubmissionEvidence } : {}),
      protocolArtifacts: buildDexterProtocolArtifacts(result),
    };
  }

  if (result.ok) {
    const merchantResponse = await toSdkMerchantResponse(result.response);

    return {
      protocol,
      executionStatus: 'preflight_failed',
      settlementEvidenceClass: 'none',
      merchantOutcome:
        merchantResponse.status >= 400 ? 'failure_response' : 'success_response',
      merchantResponse,
      diagnostic: {
        code: 'preflight_incompatible',
        message:
          'Dexter executor retried the request but the merchant did not demand payment.',
      },
      protocolArtifacts: buildDexterProtocolArtifacts(result),
    };
  }

  const failureMapping = mapDexterFailure(result.reason);

  return {
    protocol,
    executionStatus: failureMapping.executionStatus,
    settlementEvidenceClass: failureMapping.settlementEvidenceClass,
    merchantOutcome: failureMapping.merchantOutcome,
    diagnostic: {
      code: failureMapping.diagnosticCode,
      ...(result.detail ? { message: result.detail } : {}),
    },
    protocolArtifacts: buildDexterProtocolArtifacts(result),
  };
}

async function toSdkMerchantResponse(
  response: Response,
): Promise<SdkMerchantResponse> {
  return {
    status: response.status,
    headers: normalizeHeaders(response.headers) ?? {},
    body: await response.text(),
  };
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

function mapDexterFailure(
  reason: Extract<PayResult, { ok: false }>['reason'],
): {
  executionStatus: SdkDelegatedExecutionStatus;
  settlementEvidenceClass: SettlementEvidenceClass;
  merchantOutcome: SdkDelegatedMerchantOutcome;
  diagnosticCode: SdkDelegatedExecutionDiagnosticCode;
} {
  switch (reason) {
    case 'unsupported_network':
    case 'insufficient_funds':
    case 'budget_exceeded':
    case 'no_payment_options':
      return {
        executionStatus: 'preflight_failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'unknown',
        diagnosticCode: 'preflight_incompatible',
      };
    case 'merchant_rejected':
      return {
        executionStatus: 'failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'failure_response',
        diagnosticCode: 'merchant_rejected',
      };
    case 'settlement_failed':
      return {
        executionStatus: 'failed',
        settlementEvidenceClass: 'inconclusive',
        merchantOutcome: 'unknown',
        diagnosticCode: 'merchant_execution_failed',
      };
    case 'error':
      return {
        executionStatus: 'inconclusive',
        settlementEvidenceClass: 'inconclusive',
        merchantOutcome: 'no_response',
        diagnosticCode: 'merchant_transport_lost',
      };
    case 'payment_unconfirmed':
      return {
        executionStatus: 'inconclusive',
        settlementEvidenceClass: 'inconclusive',
        merchantOutcome: 'no_response',
        diagnosticCode: 'merchant_transport_lost',
      };
    case 'timeout':
      return {
        executionStatus: 'preflight_failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'no_response',
        diagnosticCode: 'merchant_transport_lost',
      };
  }
}

function buildDexterProtocolArtifacts(
  result: PayResult,
  paymentReceipt?: ReturnType<typeof getPaymentReceipt>,
) {
  if (result.ok && result.paid) {
    return {
      dexter: {
        paid: true,
        amountPaid: result.amountPaid,
        network: result.network.caip2,
        ...(result.txSignature ? { txSignature: result.txSignature } : {}),
        ...(paymentReceipt ? { paymentReceipt } : {}),
      },
    };
  }

  if (result.ok) {
    return {
      dexter: {
        paid: false,
        status: result.response.status,
      },
    };
  }

  return {
    dexter: {
      reason: result.reason,
      ...(result.detail ? { detail: result.detail } : {}),
    },
  };
}