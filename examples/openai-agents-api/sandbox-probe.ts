import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProbeError, requestText } from './transport.js';

export type ProbeConfig = {
  runId: string;
  model: string;
  canaryUrl: string;
  apiHealthUrl: string;
  merchantUrl: string;
  blockedUrl: string;
};

export type SandboxConfig = ProbeConfig & { canaryHash: string; sdkVersion: string };
export type ProbeActor = 'root' | 'child-a' | 'child-b';
export type SandboxResult = {
  runId: string;
  actor: ProbeActor;
  nodeVersion: string;
  checks: {
    nodeSupported: boolean;
    sdkPlaceholderHeader: boolean;
    secretHidden: boolean;
    vaultSubstitution: boolean;
    apiReachable: boolean;
    merchantChallenge: boolean;
    blockedDestinationRejected: boolean;
  };
};

export type ProbeSdk = {
  sdkClientVersion: string;
  sdkClientVersionHeaderName: string;
  AgentPayClient: new (options: {
    controlPlaneBaseUrl: string;
    organization: string;
    agent: string;
    auth: { type: 'runtimeToken'; runtimeToken: string };
    fetch: typeof fetch;
  }) => { lookupReceipt(id: string): Promise<unknown> };
};

export const hashAuthorization = (value: string) =>
  createHash('sha256').update(`Bearer ${value}`).digest('hex');

async function loadInstalledPackage(name: string): Promise<unknown> {
  // Both packages are installed under /workspace by trusted session setup.
  const entry = createRequire(import.meta.url).resolve(name);
  return import(pathToFileURL(entry).href) as Promise<unknown>;
}

export async function createSandboxFetch(
  { Agent, ProxyAgent }: Pick<typeof import('undici'), 'Agent' | 'ProxyAgent'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  // Node's bundled fetch does not automatically use the hosted HTTPS proxy or
  // its system CA bundle. Keep certificate and hostname verification enabled.
  const caFile =
    env.SSL_CERT_FILE ||
    env.CURL_CA_BUNDLE ||
    '/etc/ssl/certs/ca-certificates.crt';
  const ca = [...rootCertificates, await readFile(caFile, 'utf8')];
  // All probe destinations are public HTTPS. Route all of them through the
  // supplied proxy, including the negative control; do not bypass via NO_PROXY.
  const proxy =
    env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, requestTls: { ca }, proxyTls: { ca } })
    : new Agent({ connect: { ca } });
  return {
    fetch: ((input, init) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch,
    close: () => dispatcher.destroy(),
  };
}

// This file and transport.ts are compiled and supplied to the sandbox. Runtime
// imports resolve the supplied SDK tarball and pinned proxy transport package.
export async function runSandboxProbe(
  config: SandboxConfig,
  actor: ProbeActor,
  placeholder: string,
  fetchImpl: typeof fetch = fetch,
  loadSdk: () => Promise<ProbeSdk> = () =>
    loadInstalledPackage('@402flow/sdk') as Promise<ProbeSdk>,
): Promise<SandboxResult> {
  const checks: SandboxResult['checks'] = {
    nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
    sdkPlaceholderHeader: false,
    secretHidden:
      placeholder.length > 0 &&
      hashAuthorization(placeholder) !== config.canaryHash,
    vaultSubstitution: false,
    apiReachable: false,
    merchantChallenge: false,
    blockedDestinationRejected: false,
  };
  const request = (url: string, init: RequestInit = {}) =>
    requestText(fetchImpl, url, init, 15_000, 16_384);

  try {
    const sdk = await loadSdk();
    let headerMatches = false;
    const client = new sdk.AgentPayClient({
      controlPlaneBaseUrl: new URL(config.apiHealthUrl).origin,
      organization: 'capability-probe',
      agent: 'capability-probe',
      auth: { type: 'runtimeToken', runtimeToken: placeholder },
      fetch: (_input, init) => {
        headerMatches =
          new Headers(init?.headers).get('authorization') ===
            `Bearer ${placeholder}` &&
          new Headers(init?.headers).get(sdk.sdkClientVersionHeaderName) ===
            config.sdkVersion;
        // Intercept locally: this is never a real 402flow authenticated call.
        return Promise.resolve(new Response('{}', { status: 401 }));
      },
    });
    await client
      .lookupReceipt('00000000-0000-4000-8000-000000000000')
      .catch(() => undefined);
    checks.sdkPlaceholderHeader =
      sdk.sdkClientVersion === config.sdkVersion && headerMatches;
  } catch {
    /* A missing or incompatible package is a failed check. */
  }

  try {
    const response = await request(config.canaryUrl, {
      headers: { authorization: `Bearer ${placeholder}` },
    });
    const body: unknown = JSON.parse(response.text);
    checks.vaultSubstitution =
      response.ok &&
      typeof body === 'object' &&
      body !== null &&
      'authorizationSha256' in body &&
      body.authorizationSha256 === config.canaryHash;
  } catch {
    /* Do not print response bodies or errors that may contain credentials. */
  }

  try {
    const response = await request(config.apiHealthUrl);
    checks.apiReachable = response.ok;
  } catch {
    /* Record only the check result. */
  }

  try {
    const response = await request(config.merchantUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'capability probe',
        audience: 'developers',
        format: 'bullets',
      }),
    });
    const encoded = response.headers.get('payment-required');
    const challenge = encoded
      ? (JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
          x402Version?: unknown;
          resource?: { url?: unknown };
          accepts?: Array<{ network?: unknown }>;
        })
      : undefined;
    checks.merchantChallenge =
      response.status === 402 &&
      challenge?.x402Version === 2 &&
      challenge.resource?.url === config.merchantUrl &&
      Array.isArray(challenge.accepts) &&
      challenge.accepts.some((entry) => entry.network === 'eip155:84532');
  } catch {
    /* No challenge, payment signature, or response body is retained. */
  }

  try {
    await request(config.blockedUrl);
    // Even a 403 may come from the destination. Do not call that proof of egress denial.
  } catch (error) {
    // Timeouts and oversized responses are inconclusive. A transport rejection
    // plus the external baseline still does not identify DNS/TLS/proxy cause.
    checks.blockedDestinationRejected =
      error instanceof ProbeError && error.code === 'transport_failure';
  }

  return {
    runId: config.runId,
    actor,
    nodeVersion: process.versions.node,
    checks,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const actor = process.argv[2];
  if (actor !== 'root' && actor !== 'child-a' && actor !== 'child-b') {
    throw new Error('Expected root, child-a, or child-b.');
  }
  const config = JSON.parse(
    await readFile('/workspace/probe-config.json', 'utf8'),
  ) as SandboxConfig;
  try {
    const transport = await createSandboxFetch(
      (await loadInstalledPackage('undici')) as typeof import('undici'),
    );
    try {
      const result = await runSandboxProbe(
        config,
        actor,
        process.env.X402FLOW_PROBE_CANARY ?? '',
        transport.fetch,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await transport.close();
    }
  } catch {
    // Setup errors can contain proxy URLs or other environment values.
    process.stderr.write('sandbox_probe_setup_failed\n');
    process.exitCode = 1;
  }
}
