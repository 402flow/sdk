/**
 * Repo-local host-owned pay.sh adapter for x402 Solana exact delegated execution.
 * The SDK still owns authorize/finalize; this module only performs the paid retry
 * and normalizes the provider result into the delegated execution contract.
 */
import {
  x402Client,
  x402HTTPClient,
  type PaymentPolicy,
  type SelectPaymentRequirements,
  type x402PaymentResult,
} from '@x402/core/client';
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from '@x402/core/types';
import { ExactSvmScheme, type SvmClientConfig } from '@x402/svm/exact/client';

import type {
  PreparedRequestExecutor,
  SdkDelegatedExecutionResult,
  SdkDelegatedMerchantOutcome,
  SdkPreparedPaidRequestReady,
} from '@402flow/sdk';

import { buildPreparedRequestInit, toSdkMerchantResponse } from './request-utils.js';

type PayShX402HttpClient = Pick<
  x402HTTPClient,
  | 'createPaymentPayload'
  | 'encodePaymentSignatureHeader'
  | 'getPaymentRequiredResponse'
  | 'processResponse'
>;

export type PayShExecutorOptions = {
  signer: SvmClientConfig['signer'];
  fetch?: typeof fetch;
  networks?: Network[];
  paymentRequirementsSelector?: SelectPaymentRequirements;
  policies?: PaymentPolicy[];
  rpcUrl?: string;
  x402HttpClient?: PayShX402HttpClient;
};

export function createPayShExecutor(
  options: PayShExecutorOptions,
): PreparedRequestExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const x402HttpClient =
    options.x402HttpClient ?? createDefaultX402HttpClient(options);

  return {
    provider: 'pay_sh',
    async execute(input) {
      if (input.prepared.protocol !== 'x402') {
        return buildPreflightFailureResult(
          input.prepared.protocol,
          'pay.sh x402 executor only supports x402 prepared requests.',
        );
      }

      let paymentRequired: PaymentRequired;

      try {
        paymentRequired = readPreparedPaymentRequired(input.prepared, x402HttpClient);
      } catch (error) {
        return buildPreflightFailureResult(
          input.prepared.protocol,
          error instanceof Error
            ? error.message
            : 'Unable to decode the x402 payment-required challenge.',
        );
      }

      const supportedPaymentRequired = filterSupportedPaymentRequired(paymentRequired);

      if (!supportedPaymentRequired) {
        return buildPreflightFailureResult(
          input.prepared.protocol,
          'pay.sh x402 executor requires an exact Solana payment candidate with a facilitator fee payer.',
        );
      }

      let paymentPayload: PaymentPayload;

      try {
        paymentPayload = await x402HttpClient.createPaymentPayload(
          supportedPaymentRequired,
        );
      } catch (error) {
        return buildPreflightFailureResult(
          input.prepared.protocol,
          error instanceof Error
            ? error.message
            : 'pay.sh x402 payload creation failed before retry.',
        );
      }

      if (!isSupportedSvmExactRequirement(paymentPayload.accepted)) {
        return buildPreflightFailureResult(
          input.prepared.protocol,
          'pay.sh x402 executor selected an unsupported payment requirement.',
        );
      }

      let merchantResponse: Response;

      try {
        merchantResponse = await fetchImpl(
          input.prepared.request.url,
          buildPreparedRequestInit(
            input.prepared,
            x402HttpClient.encodePaymentSignatureHeader(paymentPayload),
          ),
        );
      } catch (error) {
        return buildTransportLossResult(input.prepared.protocol, error, {
          paySh: {
            x402Version: paymentPayload.x402Version,
            accepted: paymentPayload.accepted,
            payloadKeys: Object.keys(paymentPayload.payload),
          },
        });
      }

      const sdkMerchantResponse = await toSdkMerchantResponse(merchantResponse.clone());

      let processedResponse: x402PaymentResult;

      try {
        processedResponse = await x402HttpClient.processResponse(merchantResponse);
      } catch (error) {
        return buildProcessedResponseFailureResult(
          input.prepared.protocol,
          sdkMerchantResponse,
          error,
          paymentPayload,
        );
      }

      return mapProcessedResponse(
        input.prepared,
        sdkMerchantResponse,
        processedResponse,
        paymentPayload,
      );
    },
  };
}

function createDefaultX402HttpClient(options: PayShExecutorOptions) {
  const client = new x402Client(options.paymentRequirementsSelector);

  for (const policy of options.policies ?? []) {
    client.registerPolicy(policy);
  }

  const networks: Network[] = options.networks?.length
    ? options.networks
    : ['solana:*'];

  for (const network of networks) {
    client.register(
      network,
      new ExactSvmScheme(
        options.signer,
        options.rpcUrl ? { rpcUrl: options.rpcUrl } : undefined,
      ),
    );
  }

  return new x402HTTPClient(client);
}

function readPreparedPaymentRequired(
  prepared: SdkPreparedPaidRequestReady,
  x402HttpClient: PayShX402HttpClient,
) {
  const challengeHeaders = new Headers(prepared.challenge.headers);

  return x402HttpClient.getPaymentRequiredResponse(
    (name) => challengeHeaders.get(name) ?? undefined,
    prepared.challenge.body,
  );
}

function filterSupportedPaymentRequired(
  paymentRequired: PaymentRequired,
): PaymentRequired | undefined {
  const accepts = paymentRequired.accepts.filter(isSupportedSvmExactRequirement);

  if (accepts.length === 0) {
    return undefined;
  }

  return {
    ...paymentRequired,
    accepts,
  };
}

function isSupportedSvmExactRequirement(
  requirement: PaymentRequirements,
): boolean {
  return (
    requirement.scheme === 'exact'
    && requirement.network.startsWith('solana:')
    && typeof requirement.amount === 'string'
    && requirement.amount.length > 0
    && typeof requirement.asset === 'string'
    && requirement.asset.length > 0
    && typeof requirement.payTo === 'string'
    && requirement.payTo.length > 0
    && typeof requirement.extra?.feePayer === 'string'
    && requirement.extra.feePayer.length > 0
  );
}

function mapProcessedResponse(
  prepared: SdkPreparedPaidRequestReady,
  merchantResponse: Awaited<ReturnType<typeof toSdkMerchantResponse>>,
  processedResponse: x402PaymentResult,
  paymentPayload: PaymentPayload,
): SdkDelegatedExecutionResult {
  switch (processedResponse.kind) {
    case 'success':
      return buildSuccessfulResult(
        prepared.protocol,
        merchantResponse,
        processedResponse.settleResponse,
        paymentPayload,
      );
    case 'settle_failed':
      return buildSettlementFailureResult(
        prepared.protocol,
        merchantResponse,
        processedResponse.settleResponse,
        paymentPayload,
      );
    case 'payment_required':
      return {
        protocol: prepared.protocol,
        executionStatus: 'failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'failure_response',
        merchantResponse,
        diagnostic: {
          code: 'merchant_rejected',
          message:
            processedResponse.paymentRequired.error
            ?? 'merchant HTTP 402: payment required',
        },
        protocolArtifacts: {
          paySh: {
            x402Version: paymentPayload.x402Version,
            accepted: paymentPayload.accepted,
            payloadKeys: Object.keys(paymentPayload.payload),
            paymentRequired: processedResponse.paymentRequired,
          },
        },
      };
    case 'passthrough':
      return {
        protocol: prepared.protocol,
        executionStatus: 'preflight_failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: classifyMerchantOutcome(merchantResponse.status),
        merchantResponse,
        diagnostic: {
          code: 'preflight_incompatible',
          message:
            'Merchant completed the request without returning x402 settlement evidence.',
        },
        protocolArtifacts: {
          paySh: {
            x402Version: paymentPayload.x402Version,
            accepted: paymentPayload.accepted,
            payloadKeys: Object.keys(paymentPayload.payload),
          },
        },
      };
    case 'error': {
      const diagnosticCode =
        merchantResponse.status >= 500
          ? 'merchant_execution_failed'
          : 'merchant_rejected';

      return {
        protocol: prepared.protocol,
        executionStatus: 'failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: classifyMerchantOutcome(merchantResponse.status),
        merchantResponse,
        diagnostic: {
          code: diagnosticCode,
          message: `merchant HTTP ${processedResponse.status}`,
        },
        protocolArtifacts: {
          paySh: {
            x402Version: paymentPayload.x402Version,
            accepted: paymentPayload.accepted,
            payloadKeys: Object.keys(paymentPayload.payload),
          },
        },
      };
    }
  }
}

function buildSuccessfulResult(
  protocol: SdkPreparedPaidRequestReady['protocol'],
  merchantResponse: Awaited<ReturnType<typeof toSdkMerchantResponse>>,
  settleResponse: Extract<x402PaymentResult, { kind: 'success' }>['settleResponse'],
  paymentPayload: PaymentPayload,
): SdkDelegatedExecutionResult {
  const settlementReference = settleResponse.transaction;

  return {
    protocol,
    executionStatus: 'succeeded',
    settlementEvidenceClass: 'merchant_verifiable_success',
    merchantOutcome: 'success_response',
    settlementReference,
    paymentReference: settlementReference,
    evidenceSource: 'merchant',
    signerSubmissionEvidence: {
      txHash: settlementReference,
      paymentReference: settlementReference,
      ...(settleResponse.payer ? { payer: settleResponse.payer } : {}),
      ...(settleResponse.amount ? { amountMinor: settleResponse.amount } : {}),
      network: settleResponse.network,
    },
    merchantResponse,
    protocolArtifacts: {
      paySh: {
        x402Version: paymentPayload.x402Version,
        accepted: paymentPayload.accepted,
        payloadKeys: Object.keys(paymentPayload.payload),
        settleResponse,
      },
    },
  };
}

function buildSettlementFailureResult(
  protocol: SdkPreparedPaidRequestReady['protocol'],
  merchantResponse: Awaited<ReturnType<typeof toSdkMerchantResponse>>,
  settleResponse: Extract<x402PaymentResult, { kind: 'settle_failed' }>['settleResponse'],
  paymentPayload: PaymentPayload,
): SdkDelegatedExecutionResult {
  const settlementReference = settleResponse.transaction || undefined;

  return {
    protocol,
    executionStatus: 'failed',
    settlementEvidenceClass: settlementReference ? 'inconclusive' : 'none',
    merchantOutcome: classifyMerchantOutcome(merchantResponse.status),
    ...(settlementReference
      ? {
          settlementReference,
          paymentReference: settlementReference,
          evidenceSource: 'merchant' as const,
          signerSubmissionEvidence: {
            txHash: settlementReference,
            paymentReference: settlementReference,
            ...(settleResponse.payer ? { payer: settleResponse.payer } : {}),
            ...(settleResponse.amount ? { amountMinor: settleResponse.amount } : {}),
            network: settleResponse.network,
          },
        }
      : {}),
    merchantResponse,
    diagnostic: {
      code: 'merchant_execution_failed',
      message:
        settleResponse.errorMessage
        ?? settleResponse.errorReason
        ?? `x402 settlement failed with HTTP ${merchantResponse.status}`,
    },
    protocolArtifacts: {
      paySh: {
        x402Version: paymentPayload.x402Version,
        accepted: paymentPayload.accepted,
        payloadKeys: Object.keys(paymentPayload.payload),
        settleResponse,
      },
    },
  };
}

function buildProcessedResponseFailureResult(
  protocol: SdkPreparedPaidRequestReady['protocol'],
  merchantResponse: Awaited<ReturnType<typeof toSdkMerchantResponse>>,
  error: unknown,
  paymentPayload: PaymentPayload,
): SdkDelegatedExecutionResult {
  return {
    protocol,
    executionStatus: merchantResponse.status >= 500 ? 'failed' : 'preflight_failed',
    settlementEvidenceClass: 'none',
    merchantOutcome: classifyMerchantOutcome(merchantResponse.status),
    merchantResponse,
    diagnostic: {
      code:
        merchantResponse.status >= 500
          ? 'merchant_execution_failed'
          : 'preflight_incompatible',
      message:
        error instanceof Error
          ? error.message
          : 'Unable to parse x402 settlement response from merchant.',
    },
    protocolArtifacts: {
      paySh: {
        x402Version: paymentPayload.x402Version,
        accepted: paymentPayload.accepted,
        payloadKeys: Object.keys(paymentPayload.payload),
      },
    },
  };
}

function buildPreflightFailureResult(
  protocol: SdkPreparedPaidRequestReady['protocol'],
  message: string,
): SdkDelegatedExecutionResult {
  return {
    protocol,
    executionStatus: 'preflight_failed',
    settlementEvidenceClass: 'none',
    merchantOutcome: 'unknown',
    diagnostic: {
      code: 'preflight_incompatible',
      message,
    },
    protocolArtifacts: {
      paySh: {
        stage: 'preflight',
      },
    },
  };
}

function buildTransportLossResult(
  protocol: SdkPreparedPaidRequestReady['protocol'],
  error: unknown,
  protocolArtifacts?: Record<string, unknown>,
): SdkDelegatedExecutionResult {
  return {
    protocol,
    executionStatus: 'inconclusive',
    settlementEvidenceClass: 'none',
    merchantOutcome: 'no_response',
    diagnostic: {
      code: 'merchant_transport_lost',
      message:
        error instanceof Error
          ? error.message
          : 'Merchant transport failed after x402 payment dispatch.',
    },
    ...(protocolArtifacts ? { protocolArtifacts } : {}),
  };
}

function classifyMerchantOutcome(status: number): SdkDelegatedMerchantOutcome {
  if (status >= 400) {
    return 'failure_response';
  }

  if (status >= 200 && status < 400) {
    return 'success_response';
  }

  return 'unknown';
}