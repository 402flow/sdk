#!/usr/bin/env node

import {
  createEvmKeypairWallet,
} from '@dexterai/x402/client';

import { FetchPaidError, createJsonRequestBody } from '../../dist/index.js';
import { createDexterExecutor } from '../dist/dexter-executor.js';
import { createClientFromEnv, getRequiredEnv } from '../../examples/openai-tools-runtime.mjs';

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