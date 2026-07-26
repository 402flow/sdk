#!/usr/bin/env node

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
} from '@solana/kit';

import { FetchPaidError, createJsonRequestBody } from '@402flow/sdk';
import { createPayShExecutor } from '@402flow/sdk-third-party-executors/pay-sh';
import {
  createClientFromEnv,
  getRequiredEnv,
} from '../../examples/openai-tools-runtime.mjs';

const defaultBody = {
  topic: 'solana x402 receipts',
  audience: 'platform engineers',
  format: 'bullets',
};

function printHelp() {
  console.log(`Repo-local host-owned pay.sh x402 delegated executor example for @402flow/sdk

Usage:
  npm run example:pay-sh-delegated-executor -- \
    "https://merchant.example.com/paid-endpoint" \
    '{"topic":"solana x402 receipts","audience":"platform engineers","format":"bullets"}'

Required environment:
  X402FLOW_CONTROL_PLANE_BASE_URL
  X402FLOW_ORGANIZATION
  X402FLOW_AGENT
  One of: X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN
  PAY_SH_SOLANA_KEYPAIR_PATH    Path to a Solana CLI keypair JSON file

Optional environment:
  PAY_SH_SOLANA_RPC_URL         Override the Solana RPC URL used by @x402/svm
  X402FLOW_DELEGATED_TARGET_URL
  X402FLOW_DELEGATED_BODY_JSON  Default: ${JSON.stringify(defaultBody)}

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

function resolvePathWithHome(inputPath) {
  if (inputPath.startsWith('~/')) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function readKeypairBytes(filePath) {
  const resolvedPath = resolvePathWithHome(filePath);
  const parsed = parseJsonArgument(
    fs.readFileSync(resolvedPath, 'utf8'),
    'PAY_SH_SOLANA_KEYPAIR_PATH',
  );

  if (!Array.isArray(parsed) || parsed.some((value) => !Number.isInteger(value))) {
    throw new Error(
      'PAY_SH_SOLANA_KEYPAIR_PATH must point to a JSON array of 32 or 64 integer bytes.',
    );
  }

  return Uint8Array.from(parsed);
}

async function loadPayShSigner() {
  const signerBytes = readKeypairBytes(getRequiredEnv('PAY_SH_SOLANA_KEYPAIR_PATH'));

  if (signerBytes.length === 64) {
    return createKeyPairSignerFromBytes(signerBytes);
  }

  if (signerBytes.length === 32) {
    return createKeyPairSignerFromPrivateKeyBytes(signerBytes);
  }

  throw new Error(
    'PAY_SH_SOLANA_KEYPAIR_PATH must contain a 32-byte private key or 64-byte Solana keypair array.',
  );
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
  const client = await createClientFromEnv('pay.sh delegated executor example');
  const signer = await loadPayShSigner();
  const rpcUrl = process.env.PAY_SH_SOLANA_RPC_URL?.trim();
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
    description: 'repo-local pay.sh delegated executor example',
    executionProvider: 'pay_sh',
    executor: createPayShExecutor({
      signer,
      ...(rpcUrl ? { rpcUrl } : {}),
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
        signerAddress: signer.address,
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