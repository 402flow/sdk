#!/usr/bin/env node

const baseUrl =
  process.env.X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL
  ?? 'https://demo-merchant-staging.402flow.ai';
const routes = [
  '/demo-merchant/research-brief/base-sepolia',
  '/demo-merchant/research-brief/base-mainnet',
  '/demo-merchant/research-brief/solana-devnet',
  '/demo-merchant/research-brief/solana-mainnet',
];
const body = JSON.stringify({
  topic: 'hosted demo smoke test',
  audience: 'sdk integrators',
  format: 'bullets',
});
const failures = [];

for (const route of routes) {
  const requestedUrl = new URL(route, baseUrl).toString();
  const response = await fetch(requestedUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const encodedChallenge = response.headers.get('payment-required');
  let challenge;

  try {
    challenge = encodedChallenge
      ? JSON.parse(Buffer.from(encodedChallenge, 'base64').toString('utf8'))
      : undefined;
  } catch {
    // The checks below report a stable failure for malformed challenge data.
  }

  const result = {
    route,
    status: response.status,
    requestedUrl,
    challengedUrl: challenge?.resource?.url,
    x402Version: challenge?.x402Version,
    acceptedMethods: Array.isArray(challenge?.accepts)
      ? challenge.accepts.length
      : 0,
  };
  const routeFailures = [];

  if (response.status !== 402) {
    routeFailures.push(`expected HTTP 402, received ${response.status}`);
  }
  if (!encodedChallenge) {
    routeFailures.push('missing PAYMENT-REQUIRED header');
  }
  if (challenge?.x402Version !== 2) {
    routeFailures.push('expected x402Version 2');
  }
  if (result.acceptedMethods < 1) {
    routeFailures.push('challenge has no accepted payment method');
  }
  if (challenge?.resource?.url !== requestedUrl) {
    routeFailures.push(
      `challenge resource URL ${JSON.stringify(challenge?.resource?.url)} does not match ${JSON.stringify(requestedUrl)}`,
    );
  }

  console.log(JSON.stringify({ ...result, failures: routeFailures }));
  failures.push(...routeFailures.map((message) => `${route}: ${message}`));
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
