import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as sdk from '@402flow/sdk';
import { main } from '../examples/openai-agents-api/cli.js';
import {
  checkAccess,
  cleanupReport,
  cleanupResources,
  collectEvidence,
  OpenAiProbeApi,
  probeDefaults,
  reportSchema,
  runProbe,
  validateConfig,
  withReportLock,
  writeReport,
} from '../examples/openai-agents-api/probe.js';
import {
  hashAuthorization,
  runSandboxProbe,
  type ProbeConfig,
  type SandboxResult,
} from '../examples/openai-agents-api/sandbox-probe.js';
import { requestText } from '../examples/openai-agents-api/transport.js';

const config: ProbeConfig = {
  runId: 'test-run',
  model: 'test-model',
  canaryUrl: 'https://canary.example.net/probe',
  ...probeDefaults,
};
const emptyHash = createHash('sha256').update('').digest('hex');
const directories: string[] = [];
async function reportPath() {
  const dir = await mkdtemp(join(tmpdir(), 'agents-probe-test-'));
  directories.push(dir);
  return join(dir, 'report.json');
}
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const page = (data: unknown[], more = false, last: string | null = null) => ({
  data,
  has_more: more,
  last_id: last,
});
function result(actor: SandboxResult['actor']): SandboxResult {
  return {
    runId: config.runId,
    actor,
    nodeVersion: '22.22.1',
    checks: {
      nodeSupported: true,
      sdkPlaceholderHeader: true,
      secretHidden: true,
      vaultSubstitution: true,
      apiReachable: true,
      merchantChallenge: true,
      blockedDestinationRejected: true,
    },
  };
}
function turn(actor: SandboxResult['actor']) {
  return {
    id: `turn-${actor}`,
    agent_id: actor === 'root' ? 'root-agent' : actor,
    session_id: 'session-1',
    subagent_id: actor === 'root' ? null : actor,
    status: 'completed',
  };
}
function command(actor: SandboxResult['actor']) {
  return {
    id: `command-${actor}`,
    type: 'command_execution',
    command: `node /workspace/probe.mjs ${actor}`,
    turn_id: `turn-${actor}`,
    status: 'completed',
    exit_code: 0,
    output: JSON.stringify(result(actor)),
  };
}
function provider() {
  const records: Record<string, unknown> = {
    '/agents/sessions/session-1': {
      id: 'session-1',
      status: 'idle',
      environment: { id: 'env-1', type: 'openai_hosted' },
    },
    '/agents/sessions/session-1/turns': page([turn('root')]),
    '/agents/sessions/session-1/subagents': page(
      ['child-a', 'child-b'].map((id) => ({
        id,
        session_id: 'session-1',
        parent_agent_id: 'root-agent',
      })),
    ),
  };
  records['/agents/environments/env-1'] = { id: 'env-1', status: 'connected' };
  for (const actor of ['root', 'child-a', 'child-b'] as const) {
    const base = `/agents/sessions/session-1${actor === 'root' ? '' : `/subagents/${actor}`}`;
    records[`${base}/items`] = page([command(actor)]);
    records[`${base}/turns/turn-${actor}`] = turn(actor);
  }
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    calls.push({ path, method, body });
    if (url.origin === 'https://example.com') return json({ ok: true });
    if (url.origin === 'https://canary.example.net')
      return json({ authorizationSha256: emptyHash });
    if (method === 'DELETE' || path.endsWith('/events')) return json({});
    if (method === 'POST') {
      if (path === '/vaults') return json({ id: 'vault-1' });
      if (path.endsWith('/credentials')) return json({ id: 'credential-1' });
      if (path === '/agents/sessions') return json({ id: 'session-1' });
    }
    if (path === '/agents' || path === '/vaults') return json(page([]));
    if (path === '/models/test-model') return json({ id: config.model });
    if (path.startsWith('/vaults/'))
      return json({ id: path.split('/').at(-1) });
    if (records[path]) return json(records[path]);
    throw new Error('Unexpected mocked route');
  });
  return {
    records,
    fetchImpl,
    calls,
    api: new OpenAiProbeApi('test-openai-key', [], fetchImpl),
  };
}
const sessionBuilder = () => Promise.resolve({});
const noWait: typeof delay = <T>(_ms?: number, value?: T) =>
  Promise.resolve(value as T);

// These use the actual SDK, not a reimplementation of its auth header logic.
describe('hosted probe', () => {
  it('forwards the placeholder through the SDK and sends credentials only to the canary', async () => {
    const canaryHash = hashAuthorization('inert-real-value');
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      expect(init?.redirect).toBe('error');
      if (url === config.canaryUrl) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer vault-placeholder',
        );
        return json({ authorizationSha256: canaryHash });
      }
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      if (url === config.merchantUrl) {
        return new Response(null, {
          status: 402,
          headers: {
            'payment-required': Buffer.from(
              JSON.stringify({
                x402Version: 2,
                resource: { url },
                accepts: [{ network: 'eip155:84532' }],
              }),
            ).toString('base64'),
          },
        });
      }
      if (url === config.blockedUrl) throw new Error('network denied');
      return json({ ok: true });
    });
    const output = await runSandboxProbe(
      { ...config, canaryHash },
      'root',
      'vault-placeholder',
      fetchImpl,
      () => Promise.resolve(sdk),
    );
    expect(Object.values(output.checks).every(Boolean)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(output)).not.toMatch(
      /inert-real-value|vault-placeholder/,
    );
  });

  it('fails visible secrets, wrong substitution, wrong merchant network, and HTTP responses from blocked hosts', async () => {
    const output = await runSandboxProbe(
      { ...config, canaryHash: hashAuthorization('visible') },
      'child-a',
      'visible',
      async () => json({ authorizationSha256: emptyHash }, 403),
      () => Promise.resolve(sdk),
    );
    expect(output.checks).toMatchObject({
      sdkPlaceholderHeader: true,
      secretHidden: false,
      vaultSubstitution: false,
      merchantChallenge: false,
      apiReachable: false,
      blockedDestinationRejected: false,
    });
  });
});

describe('provider boundary', () => {
  it('preflight only reads access and the explicitly selected model', async () => {
    const p = provider();
    expect(Object.values(await checkAccess(p.api, config.model))).toEqual([
      'accessible',
      'accessible',
      'accessible',
    ]);
    expect(p.calls.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/agents'],
      ['GET', '/vaults'],
      ['GET', '/models/test-model'],
    ]);
  });
  it('redacts provider bodies, thrown errors, and reflected secrets', async () => {
    for (const [response, code] of [
      [json({ error: 'private body' }, 403), 'openai_http_403'],
      [json({ content: 'test-key' }), 'secret_exposed_by_provider'],
      [json({ content: 'inert-canary' }), 'secret_exposed_by_provider'],
    ] as const) {
      const api = new OpenAiProbeApi(
        'test-key',
        ['inert-canary'],
        async () => response,
      );
      await expect(api.request('/agents')).rejects.toThrow(code);
    }
    const api = new OpenAiProbeApi('test-key', [], async () => {
      throw new Error('secret key detail');
    });
    await expect(api.request('/agents')).rejects.toThrow('transport_failure');
  });
  it('bounds streamed bodies and cancels stalled reads on deadline', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel,
    });
    await expect(
      requestText(
        async () => new Response(stream),
        'https://example.com',
        {},
        1000,
        10,
      ),
    ).rejects.toThrow('response_too_large');
    expect(cancel).toHaveBeenCalled();
    let signal: AbortSignal | null | undefined;
    await expect(
      requestText(
        async (_input, init) => {
          signal = init?.signal;
          return new Response(new ReadableStream());
        },
        'https://example.com',
        {},
        10,
        100,
      ),
    ).rejects.toThrow('request_timeout');
    expect(signal?.aborted).toBe(true);
  });
  it('follows pages and rejects repeating or exhausted cursors', async () => {
    const seen: string[] = [];
    const api = new OpenAiProbeApi('test-key', [], async (input) => {
      const after = new URL(String(input)).searchParams.get('after');
      seen.push(after ?? 'first');
      return json(after ? page([{ id: 'b' }]) : page([{ id: 'a' }], true, 'a'));
    });
    expect(await api.list('/agents')).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(seen).toEqual(['first', 'a']);
    const repeat = new OpenAiProbeApi('test-key', [], async () =>
      json(page([{}], true, 'same')),
    );
    await expect(repeat.list('/agents')).rejects.toThrow('invalid_pagination');
    let n = 0;
    const unlimited = new OpenAiProbeApi('test-key', [], async () =>
      json(page([{}], true, `id-${++n}`)),
    );
    await expect(unlimited.list('/agents')).rejects.toThrow('pagination_limit');
  });
});

describe('provider attribution', () => {
  it('accepts the exact hosted bash wrapper but rejects appended shell operations', async () => {
    const p = provider();
    const base = '/agents/sessions/session-1';
    p.records[`${base}/items`] = page([
      {
        ...command('root'),
        command: "/bin/bash -lc 'node /workspace/probe.mjs root'",
      },
    ]);
    expect(
      await collectEvidence(p.api, 'session-1', config.runId),
    ).toHaveLength(3);
    for (const text of [
      "/bin/bash -lc 'node /workspace/probe.mjs root; env'",
      "/bin/bash -lc 'node /workspace/probe.mjs root' && env",
      'node /workspace/probe.mjs root > /tmp/result',
    ]) {
      p.records[`${base}/items`] = page([
        { ...command('root'), command: text },
      ]);
      await expect(
        collectEvidence(p.api, 'session-1', config.runId),
      ).rejects.toThrow('unexpected_probe_command');
    }
  });
  it('joins root and two distinct subagents to their own completed turns', async () => {
    const p = provider();
    const evidence = await collectEvidence(p.api, 'session-1', config.runId);
    expect(evidence.map((entry) => entry.subagentId)).toEqual([
      null,
      'child-a',
      'child-b',
    ]);
  });
  it.each([
    'forged-label',
    'wrong-session',
    'wrong-child',
    'same-child',
    'duplicate',
    'extra-command',
    'failed-command',
    'malformed-output',
    'wrong-parent',
  ])('rejects %s evidence', async (failure) => {
    const p = provider();
    const base = '/agents/sessions/session-1/subagents/child-a';
    if (failure === 'forged-label')
      p.records[`${base}/items`] = page([
        { ...command('child-a'), output: JSON.stringify(result('root')) },
      ]);
    if (failure === 'wrong-session')
      p.records[`${base}/turns/turn-child-a`] = {
        ...turn('child-a'),
        session_id: 'other-session',
      };
    if (failure === 'wrong-child')
      p.records[`${base}/turns/turn-child-a`] = {
        ...turn('child-a'),
        subagent_id: 'child-b',
      };
    if (failure === 'same-child')
      p.records['/agents/sessions/session-1/subagents'] = page(
        [1, 2].map(() => ({
          id: 'child-a',
          session_id: 'session-1',
          parent_agent_id: 'root-agent',
        })),
      );
    if (failure === 'duplicate')
      p.records[`${base}/items`] = page([
        command('child-a'),
        command('child-a'),
      ]);
    if (failure === 'extra-command')
      p.records[`${base}/items`] = page([
        command('child-a'),
        { ...command('child-a'), command: 'env' },
      ]);
    if (failure === 'failed-command')
      p.records[`${base}/items`] = page([
        { ...command('child-a'), exit_code: 1 },
      ]);
    if (failure === 'malformed-output')
      p.records[`${base}/items`] = page([
        { ...command('child-a'), output: '{}' },
      ]);
    if (failure === 'wrong-parent')
      p.records['/agents/sessions/session-1/subagents'] = page(
        ['child-a', 'child-b'].map((id) => ({
          id,
          session_id: 'session-1',
          parent_agent_id: id,
        })),
      );
    await expect(
      collectEvidence(p.api, 'session-1', config.runId),
    ).rejects.toThrow();
  });
});

it('rejects siblings whose shared parent is not the agent that ran the root probe', async () => {
  const p = provider();
  p.records['/agents/sessions/session-1/subagents'] = page(
    ['child-a', 'child-b'].map((id) => ({
      id,
      session_id: 'session-1',
      parent_agent_id: 'unrelated-root-agent',
    })),
  );
  await expect(
    collectEvidence(p.api, 'session-1', config.runId),
  ).rejects.toThrow('attribution_mismatch');
});

describe('checkpoint and cleanup', () => {
  it('completes a simulated run, retaining only validated evidence and resource IDs', async () => {
    const p = provider();
    const path = await reportPath();
    const report = await runProbe(config, 'test-openai-key', path, {
      fetchImpl: p.fetchImpl,
      sessionBuilder,
      wait: noWait,
    });
    expect(report.state).toBe('passed');
    expect(report.evidence).toHaveLength(3);
    expect(Object.values(report.cleanup)).toEqual([
      'deleted',
      'deleted',
      'deleted',
    ]);
    expect(
      reportSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
    ).toEqual(report);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const credential = p.calls.find(
      (entry) => entry.path.endsWith('/credentials') && entry.method === 'POST',
    );
    const secret = (credential?.body as { auth: { secret_value: string } }).auth
      .secret_value;
    expect(await readFile(path, 'utf8')).not.toContain(secret);
    expect(await readFile(path, 'utf8')).not.toContain('test-openai-key');
    expect(
      p.calls.some((call) => /payment|runtime-token/.test(call.path)),
    ).toBe(false);
    const firstCleanup = p.calls.findIndex((entry) =>
      entry.path.endsWith('/events'),
    );
    expect(p.calls.slice(firstCleanup).map((entry) => entry.method)).toEqual([
      'POST',
      'DELETE',
      'DELETE',
      'DELETE',
    ]);
  });
  it('requires the unauthenticated receiver to hash exactly the empty header', async () => {
    const p = provider();
    const report = await runProbe(
      config,
      'test-openai-key',
      await reportPath(),
      {
        sessionBuilder,
        fetchImpl: async (input, init) =>
          String(input) === config.canaryUrl
            ? json({ authorizationSha256: hashAuthorization('') })
            : p.fetchImpl(input, init),
      },
    );
    expect(report.error).toBe('canary_receiver_unavailable');
    expect(p.calls.every((entry) => entry.method === 'GET')).toBe(true);
  });
  it('checkpoints before creation and never retries a lost session creation response', async () => {
    const p = provider();
    const path = await reportPath();
    let creates = 0;
    const report = await runProbe(config, 'test-openai-key', path, {
      sessionBuilder,
      wait: noWait,
      fetchImpl: async (input, init) => {
        if (
          String(input).endsWith('/agents/sessions') &&
          init?.method === 'POST'
        ) {
          creates++;
          const checkpoint = reportSchema.parse(
            JSON.parse(await readFile(path, 'utf8')),
          );
          expect(checkpoint.resources).toEqual({
            vaultId: 'vault-1',
            credentialId: 'credential-1',
            pendingCreation: 'session',
          });
          throw new Error('lost response with sensitive details');
        }
        return p.fetchImpl(input, init);
      },
    });
    expect(creates).toBe(1);
    expect(report.resources.pendingCreation).toBe('session');
    expect(report.state).toBe('failed');
    expect(report.error).toBe('transport_failure');
    const recovered = await cleanupReport(path, p.api);
    expect(recovered.resources.pendingCreation).toBe('session');
    expect(recovered.state).toBe('failed');
  });
  it('idle sessions without a completed root time out and still clean up', async () => {
    const p = provider();
    p.records['/agents/sessions/session-1/turns'] = page([]);
    const report = await runProbe(
      config,
      'test-openai-key',
      await reportPath(),
      { sessionBuilder, timeoutMs: 50, fetchImpl: p.fetchImpl },
    );
    expect(report.error).toBe('probe_timeout');
    expect(report.state).toBe('failed');
    expect(report.cleanup['/agents/sessions/session-1']).toBe('deleted');
  });
  it('checks setup status at the separate environment endpoint and fails closed', async () => {
    const p = provider();
    p.records['/agents/environments/env-1'] = { id: 'env-1', status: 'failed' };
    const report = await runProbe(
      config,
      'test-openai-key',
      await reportPath(),
      { sessionBuilder, fetchImpl: p.fetchImpl },
    );
    expect(report.error).toBe('environment_failed');
    expect(report.state).toBe('failed');
    expect(report.evidence).toEqual([]);
    expect(report.cleanup['/agents/sessions/session-1']).toBe('deleted');
  });
  it('stops on interrupt but uses a separate signal for cleanup', async () => {
    const p = provider();
    const controller = new AbortController();
    const report = await runProbe(
      config,
      'test-openai-key',
      await reportPath(),
      {
        sessionBuilder,
        signal: controller.signal,
        fetchImpl: async (input, init) => {
          const response = await p.fetchImpl(input, init);
          if (
            String(input).endsWith('/agents/sessions') &&
            init?.method === 'POST'
          )
            controller.abort();
          if (init?.method === 'DELETE')
            expect(init.signal?.aborted).toBe(false);
          return response;
        },
      },
    );
    expect(report.error).toBe('interrupted');
    expect(
      Object.values(report.cleanup).every((value) => value === 'deleted'),
    ).toBe(true);
  });
  it('bounds 409 cleanup retries, treats 404 as deleted, and keeps failed IDs', async () => {
    let attempts = 0;
    const api = new OpenAiProbeApi('key', [], async (input, init) => {
      if (init?.method === 'DELETE' && String(input).includes('/sessions/')) {
        attempts++;
        return json({}, 409);
      }
      return json({}, 404);
    });
    const resources = { sessionId: 'session-1', vaultId: 'vault-1' };
    expect(await cleanupResources(api, resources, noWait)).toEqual({
      '/agents/sessions/session-1': 'failed',
      '/vaults/vault-1': 'deleted',
    });
    expect(attempts).toBe(3);
    expect(resources.sessionId).toBe('session-1');
  });
  it('does not overwrite reports or allow simultaneous local recovery', async () => {
    const path = await reportPath();
    await writeReport(path, { preserved: true });
    const p = provider();
    await expect(
      runProbe(config, 'key', path, { fetchImpl: p.fetchImpl }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      preserved: true,
    });
    expect(p.calls).toHaveLength(0);
    await withReportLock(path, async () => {
      await expect(
        withReportLock(path, () => Promise.resolve()),
      ).rejects.toThrow();
    });
  });
  it('rejects malicious saved resource paths before any cleanup requests', async () => {
    const p = provider();
    const path = await reportPath();
    const report = await runProbe(config, 'key', path, {
      fetchImpl: p.fetchImpl,
      sessionBuilder,
    });
    report.resources.sessionId = '../../unrelated';
    await writeReport(path, report);
    const count = p.calls.length;
    await expect(cleanupReport(path, p.api)).rejects.toThrow();
    expect(p.calls).toHaveLength(count);
  });
});

describe('launcher configuration', () => {
  it.each([
    'http://canary.example.net/probe',
    'https://localhost/probe',
    'https://127.0.0.1/probe',
    'https://[::1]/probe',
    'https://canary.example.net/probe?token=secret',
    'https://user:password@canary.example.net/probe',
    'https://canary.example.net:123/probe',
    'https://api-staging.402flow.ai/probe',
    'https://api.openai.com/probe',
  ])('rejects unsafe receiver %s', (canaryUrl) =>
    expect(() => validateConfig({ ...config, canaryUrl })).toThrow(),
  );
  it('rejects arbitrary merchant URLs and accepts a dedicated public receiver', () => {
    expect(validateConfig(config)).toEqual(config);
    expect(() =>
      validateConfig({
        ...config,
        merchantUrl:
          'https://unowned.example.net/demo-merchant/research-brief/base-sepolia',
      }),
    ).toThrow();
  });
  it('plans without network access and refuses a hosted run missing configuration', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(['plan'], { OPENAI_API_KEY: 'secret' });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).not.toContain('secret');
    await expect(main(['run'], { OPENAI_API_KEY: 'secret' })).rejects.toThrow(
      'run_requires_model_and_approved_canary_url',
    );
  });
});

describe('compiled hosted payload', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['examples/openai-agents-api/build.mjs'], {
      stdio: 'pipe',
    });
  });
  it('loads the packaged SDK and rewritten paid-request modules in an isolated workspace', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      import { execFileSync } from 'node:child_process';
      import { tmpdir } from 'node:os';
      import { join, resolve } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { AgentPayClient } from '@402flow/sdk';
      import { buildPaidRequestSession } from './examples/openai-agents-api/dist/paid-request.js';
      import { makeCheckpoint, controlPlaneBaseUrl, requestBody, paymentAsset, merchantUrl } from './examples/openai-agents-api/dist/paid-request-contract.js';
      const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
      const config={operationId:id(1),organizationId:id(2),agentId:id(3),credentialId:id(4),requestPolicyId:id(7),budgetPolicyId:id(5),model:'test-model',expectedOutcome:'denied',maxAmountMinor:'1000',maxBudgetAmountMinor:'100000'};
      const identity={organization:'test-org',agent:'test-agent'};
      const challenge={x402Version:2,resource:{url:merchantUrl},accepts:[{scheme:'exact',network:'eip155:84532',asset:paymentAsset,amount:'1000',payTo:'0x1111111111111111111111111111111111111111',maxTimeoutSeconds:60}]};
      const client=new AgentPayClient({controlPlaneBaseUrl:controlPlaneBaseUrl,...identity,auth:{type:'runtimeToken',runtimeToken:'unused'},fetch:async()=>new Response('{}',{status:402,headers:{'payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')}})});
      const checkpoint=makeCheckpoint(config,identity,await client.preparePaidRequest(merchantUrl,{method:'POST',headers:{'content-type':'application/json'},body:requestBody}));
      const payload=await buildPaidRequestSession(checkpoint,'vault-fixture','test-model');
      const directory=await mkdtemp(join(tmpdir(),'packaged-hosted-'));
      try {
        for(const file of payload.environment.files)await writeFile(join(directory,file.path.replace('/workspace/','')),Buffer.from(file.data,'base64'));
        const sdkDirectory=join(directory,'node_modules/@402flow/sdk');await mkdir(sdkDirectory,{recursive:true});
        execFileSync('tar',['-xzf',join(directory,'402flow-sdk-0.1.3.tgz'),'-C',sdkDirectory,'--strip-components=1']);
        for(const name of ['zod','undici'])await symlink(resolve('node_modules',name),join(directory,'node_modules',name));
        const { executeCheckpoint }=await import(pathToFileURL(join(directory,'execute-request.mjs')).href);
        let version;let calls=0;
        const result=await executeCheckpoint(checkpoint,'inert-placeholder',async(input,init)=>{
          if(String(input)!==controlPlaneBaseUrl+'/api/sdk/payment-decisions')throw new Error('unexpected route');
          version=new Headers(init.headers).get('x-402flow-sdk-version');calls++;
          return new Response(JSON.stringify({outcome:'deny',paidRequestId:id(6),reasonCode:'policy_denied',reason:'fixture'}),{status:200,headers:{'content-type':'application/json'}});
        });
        const tarball=payload.environment.files.find(file=>file.path.endsWith('.tgz'));
        console.log(JSON.stringify({version,calls,result,domains:payload.environment.network.allowed_domains,multiAgent:payload.agent.multi_agent,hashMatches:createHash('sha256').update(Buffer.from(tarball.data,'base64')).digest('hex')===payload.metadata.sdk_artifact_sha256}));
      } finally {await rm(directory,{recursive:true,force:true});}
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toMatchObject({
      version: '0.1.3',
      calls: 1,
      result: { kind: 'denied' },
      domains: ['api-staging.402flow.ai'],
      multiAgent: { enabled: false },
      hashMatches: true,
    });
  });
  it('pins the SDK and isolates the vault from plaintext environment configuration', async () => {
    // Exercise compiled assets exactly as the Node 20 launcher loads them.
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { buildSession } from './examples/openai-agents-api/dist/probe.js';
      console.log(JSON.stringify(await buildSession(${JSON.stringify(config)}, 'vault-1', '${hashAuthorization('inert')}')));
    `,
      ],
      { encoding: 'utf8' },
    );
    const payload = JSON.parse(output);
    expect(payload.vault_ids).toEqual(['vault-1']);
    expect(payload.environment.env).toBeUndefined();
    expect(payload.environment.packages.npm).toEqual([
      'undici@6.28.1',
      'zod@3.25.76',
    ]);
    expect(payload.environment.network.allowed_domains).toEqual([
      'canary.example.net',
      'api-staging.402flow.ai',
      'demo-merchant-staging.402flow.ai',
    ]);
    expect(payload.agent.multi_agent).toEqual({
      enabled: true,
      max_concurrent_subagents: 2,
    });
    const source = Buffer.from(
      (payload.environment.files as Array<{ path: string; data: string }>).find(
        (file: { path: string }) => file.path === '/workspace/probe.mjs',
      )!.data,
      'base64',
    ).toString();
    expect(source).toContain("from './transport.mjs'");
    expect(source).not.toMatch(/fetchPaid\(|executePreparedRequest\(/);
  });
});
