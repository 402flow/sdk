#!/usr/bin/env node

import {
  createEvmKeypairWallet,
  getPaymentReceipt,
  payAndFetch,
} from '@dexterai/x402/client';

import { FetchPaidError, createJsonRequestBody } from '../dist/index.js';
import { createClientFromEnv, getRequiredEnv } from './openai-tools-runtime.mjs';

const defaultBody = {
  topic: 'sdk integration rollout',
  audience: 'platform engineers',
  format: 'bullets',
};

function printHelp() {
  console.log(`Repo-local host-owned Dexter executor example for @402flow/sdk

Usage:
  npm run example:dexter-delegated-executor -- \
    "https://merchant.example.com/paid-endpoint" \
    '{"topic":"sdk integration rollout","audience":"platform engineers","format":"bullets"}'

Required environment:
  X402FLOW_CONTROL_PLANE_BASE_URL
  X402FLOW_ORGANIZATION
  X402FLOW_AGENT
  One of: X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN
  DEXTER_EVM_PRIVATE_KEY

Optional environment:
  X402FLOW_DELEGATED_TARGET_URL
  X402FLOW_DELEGATED_BODY_JSON   Default: ${JSON.stringify(defaultBody)}

Arguments:
  [url]       Paid merchant URL. Falls back to X402FLOW_DELEGATED_TARGET_URL.
  [bodyJson]  JSON request body string. Falls back to X402FLOW_DELEGATED_BODY_JSON.
`);
}

function normalizeHeaders(headers) {
  if (!headers) {
    return undefined;
  }

  const normalizedHeaders = {};
  const headerMap = new Headers(headers);

  headerMap.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  return normalizedHeaders;
}

async function toMerchantResponse(response) {
  return {
    status: response.status,
    headers: normalizeHeaders(response.headers) ?? {},
    body: await response.text(),
  };
}

function createDexterExecutor({ wallets, payAndFetchOptions = {} }) {
  return {
    provider: 'dexter',
    async execute({ prepared }) {
      const result = await payAndFetch(
        prepared.request.url,
        {
          method: prepared.request.method,
          ...(prepared.request.headers ? { headers: prepared.request.headers } : {}),
          ...(prepared.request.body !== undefined ? { body: prepared.request.body } : {}),
        },
        wallets,
        payAndFetchOptions,
      );

      return mapDexterPayResult(prepared, result);
    },
  };
}

async function mapDexterPayResult(prepared, result) {
  if (result.ok && result.paid) {
    const merchantResponse = result.response
      ? await toMerchantResponse(result.response)
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
        protocol: prepared.protocol,
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
        protocolArtifacts: {
          dexter: {
            paid: true,
            amountPaid: result.amountPaid,
            network: result.network.caip2,
            ...(result.txSignature ? { txSignature: result.txSignature } : {}),
            ...(paymentReceipt ? { paymentReceipt } : {}),
          },
        },
      };
    }

    return {
      protocol: prepared.protocol,
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
      protocolArtifacts: {
        dexter: {
          paid: true,
          amountPaid: result.amountPaid,
          network: result.network.caip2,
        },
      },
    };
  }

  if (result.ok) {
    const merchantResponse = await toMerchantResponse(result.response);

    return {
      protocol: prepared.protocol,
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
      protocolArtifacts: {
        dexter: {
          paid: false,
          status: result.response.status,
        },
      },
    };
  }

  switch (result.reason) {
    case 'unsupported_network':
    case 'insufficient_funds':
    case 'budget_exceeded':
    case 'no_payment_options':
      return {
        protocol: prepared.protocol,
        executionStatus: 'preflight_failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'unknown',
        diagnostic: {
          code: 'preflight_incompatible',
          ...(result.detail ? { message: result.detail } : {}),
        },
        protocolArtifacts: {
          dexter: {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
        },
      };
    case 'merchant_rejected':
      return {
        protocol: prepared.protocol,
        executionStatus: 'failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'failure_response',
        diagnostic: {
          code: 'merchant_rejected',
          ...(result.detail ? { message: result.detail } : {}),
        },
        protocolArtifacts: {
          dexter: {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
        },
      };
    case 'settlement_failed':
      return {
        protocol: prepared.protocol,
        executionStatus: 'failed',
        settlementEvidenceClass: 'inconclusive',
        merchantOutcome: 'unknown',
        diagnostic: {
          code: 'merchant_execution_failed',
          ...(result.detail ? { message: result.detail } : {}),
        },
        protocolArtifacts: {
          dexter: {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
        },
      };
    case 'error':
    case 'payment_unconfirmed':
      return {
        protocol: prepared.protocol,
        executionStatus: 'inconclusive',
        settlementEvidenceClass: 'inconclusive',
        merchantOutcome: 'no_response',
        diagnostic: {
          code: 'merchant_transport_lost',
          ...(result.detail ? { message: result.detail } : {}),
        },
        protocolArtifacts: {
          dexter: {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
        },
      };
    case 'timeout':
      return {
        protocol: prepared.protocol,
        executionStatus: 'preflight_failed',
        settlementEvidenceClass: 'none',
        merchantOutcome: 'no_response',
        diagnostic: {
          code: 'merchant_transport_lost',
          ...(result.detail ? { message: result.detail } : {}),
        },
        protocolArtifacts: {
          dexter: {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
        },
      };
  }
}

function parseJsonArgument(rawValue, label) {
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatMaybeJson(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const firstArg = args[0]?.trim();

  if (firstArg === '--help') {
    printHelp();
    process.exit(0);
  }

  const targetUrl = firstArg || process.env.X402FLOW_DELEGATED_TARGET_URL;

  if (!targetUrl) {
    printHelp();
    process.exit(1);
  }

  const bodyInput =
    args[1]
    ?? process.env.X402FLOW_DELEGATED_BODY_JSON
    ?? JSON.stringify(defaultBody);
  const requestBody = createJsonRequestBody(
    parseJsonArgument(bodyInput, 'bodyJson'),
  );
  const client = await createClientFromEnv('Dexter delegated executor example');
  const dexterWallet = await createEvmKeypairWallet(
    getRequiredEnv('DEXTER_EVM_PRIVATE_KEY'),
  );
  const prepared = await client.preparePaidRequest(targetUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: requestBody,
  });

  if (prepared.kind !== 'ready') {
    console.log(
      JSON.stringify(
        {
          kind: prepared.kind,
          nextAction: prepared.nextAction,
          validationIssues: prepared.validationIssues,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await client.executePreparedRequest(prepared, {
    description: 'repo-local Dexter delegated executor example',
    executionProvider: 'dexter',
    executor: createDexterExecutor({
      wallets: {
        evm: dexterWallet,
      },
    }),
  });

  const merchantBody = await result.response.text();

  console.log(
    JSON.stringify(
      {
        kind: result.kind,
        status: result.response.status,
        paidRequestId: result.paidRequestId,
        paymentAttemptId: result.paymentAttemptId,
        ...(result.kind === 'success' ? { receiptId: result.receiptId } : {}),
        merchantBody: formatMaybeJson(merchantBody),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  if (error instanceof FetchPaidError) {
    console.error(
      JSON.stringify(
        {
          kind: error.kind,
          reason: error.reason,
          paidRequestId: error.paidRequestId,
          paymentAttemptId: error.paymentAttemptId,
          policyReviewEventId: error.policyReviewEventId,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});