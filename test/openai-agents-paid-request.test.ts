import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPayClient, sdkClientVersion } from '@402flow/sdk';
import {
  makeCheckpoint,
  controlPlaneBaseUrl,
  paymentAsset,
  requestBody,
  merchantUrl,
  validateCheckpoint,
  type PaidRequestConfig,
} from '../examples/openai-agents-api/paid-request-contract.js';
import {
  executeCheckpoint,
  createExecutionFetch,
} from '../examples/openai-agents-api/execute-request.js';
import {
  runPaidRequest,
  paidRequestReportSchema,
} from '../examples/openai-agents-api/paid-request.js';
import {
  ControlPlaneClient,
  preflightPaidRequest,
  verifyPaymentEvidence,
} from '../examples/openai-agents-api/control-plane.js';
import { mainPaidRequest } from '../examples/openai-agents-api/paid-request-cli.js';
import { main } from '../examples/openai-agents-api/cli.js';
import { writeReport } from '../examples/openai-agents-api/probe.js';
import { baseReceipt } from './agent-pay-client.test-fixtures.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config: PaidRequestConfig = {
  operationId: id(1),
  organizationId: id(2),
  agentId: id(3),
  credentialId: id(4),
  requestPolicyId: id(21),
  budgetPolicyId: id(5),
  model: 'test-model',
  expectedOutcome: 'success',
  maxAmountMinor: '1000',
  maxBudgetAmountMinor: '100000',
};
const identity = { organization: 'test-org', agent: 'test-agent' };
const secrets = {
  openaiKey: 'test-openai-key',
  bootstrapKey: 'test-bootstrap-key',
  operatorToken: 'test-operator-token',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const page = (data: unknown[]) => ({ data, has_more: false, last_id: null });
const authContext = {
  runtimeSessionId: id(6),
  credentialId: config.credentialId,
  scope: ['sdk'],
};
const supportedMethod = {
  protocol: 'x402',
  network: 'base-sepolia',
  asset: 'usdc',
};
const receipt = {
  authContext,
  supportedMethod,
  settlementStatus: 'confirmed',
  ...baseReceipt,
  receiptId: id(10),
  paidRequestId: id(11),
  paymentAttemptId: id(12),
  organizationId: config.organizationId,
  agentId: config.agentId,
  requestUrl: merchantUrl,
  money: { ...baseReceipt.money, amount: '0.001000', amountMinor: '1000' },
  evidenceSource: 'merchant',
  fulfillmentStatus: 'succeeded',
};
const outcome = {
  kind: 'success',
  paidRequestId: receipt.paidRequestId,
  paymentAttemptId: receipt.paymentAttemptId,
  receiptId: receipt.receiptId,
  responseStatus: 200,
  bodySha256: '0'.repeat(64),
  receiptVerified: true,
};
function challenge(amount = '1000', network = 'eip155:84532') {
  return new Response('{}', {
    status: 402,
    headers: {
      'payment-required': Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: merchantUrl },
          accepts: [
            {
              scheme: 'exact',
              network,
              amount,
              asset: paymentAsset,
              payTo: '0x1111111111111111111111111111111111111111',
              maxTimeoutSeconds: 60,
              extra: { name: 'USDC', version: '2' },
            },
          ],
        }),
      ).toString('base64'),
    },
  });
}
async function checkpoint() {
  const sdk = new AgentPayClient({
    controlPlaneBaseUrl,
    ...identity,
    auth: { type: 'runtimeToken', runtimeToken: 'unused' },
    fetch: async () => challenge(),
  });
  return makeCheckpoint(
    config,
    identity,
    await sdk.preparePaidRequest(merchantUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    }),
  );
}
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function path() {
  const dir = await mkdtemp(join(tmpdir(), 'paid-request-test-'));
  dirs.push(dir);
  return join(dir, 'report.json');
}
function provider() {
  const org = `/api/organizations/${config.organizationId}`;
  const agent = `${org}/agents/${config.agentId}`;
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const runtime = {
    id: id(6),
    organizationId: config.organizationId,
    agentId: config.agentId,
    credentialId: config.credentialId,
    status: 'active',
    scope: ['sdk'],
    expiresAt,
  };
  const records: Record<string, unknown> = {
    [org]: {
      organization: {
        id: config.organizationId,
        externalId: identity.organization,
        governancePosture: 'deny_by_default',
      },
    },
    [agent]: {
      agent: {
        id: config.agentId,
        organizationId: config.organizationId,
        externalId: identity.agent,
        status: 'enabled',
        lifecycleStatus: 'active',
      },
    },
    [`${agent}/bootstrap-credentials/${config.credentialId}`]: {
      credential: {
        id: config.credentialId,
        agentId: config.agentId,
        organizationId: config.organizationId,
        status: 'active',
      },
    },
    [`${org}/policies/${config.budgetPolicyId}`]: {
      policy: {
        id: config.budgetPolicyId,
        organizationId: config.organizationId,
        currentRevisionId: id(7),
        enabled: true,
        lifecycleStatus: 'active',
        definition: {
          metric: 'amount',
          basis: 'aggregate_over_time',
          window: 'day',
          scopeKind: 'agents',
          populationMode: 'selected',
          agentIds: [config.agentId],
          applicationMode: 'per_member',
          maxAmount: { asset: 'USDC', amountMinor: '100000', precision: 6 },
        },
      },
    },
    [`${org}/policies/${config.requestPolicyId}`]: {
      policy: {
        id: config.requestPolicyId,
        organizationId: config.organizationId,
        currentRevisionId: id(22),
        enabled: true,
        lifecycleStatus: 'active',
        definition: {
          metric: 'amount',
          basis: 'per_request',
          window: 'none',
          scopeKind: 'agents',
          populationMode: 'selected',
          agentIds: [config.agentId],
          applicationMode: 'per_member',
          maxAmount: { asset: 'USDC', amountMinor: '1000', precision: 6 },
        },
      },
    },
    [`${org}/payment-connections`]: {
      paymentRails: [
        {
          id: id(20),
          organizationId: config.organizationId,
          type: 'x402',
          status: 'enabled',
          lifecycleStatus: 'active',
          config: { network: 'base-sepolia' },
        },
      ],
    },
    [`${org}/wallets/coverage`]: {
      paymentRailCoverage: [
        {
          protocol: 'x402',
          network: 'base-sepolia',
          asset: 'usdc',
          coverageStatus: 'ready',
          compatibleEnabledWallets: [{ walletId: id(8) }],
          activeWallet: { walletId: id(8) },
        },
      ],
    },
    [`${org}/paid-requests/${receipt.paidRequestId}`]: {
      paidRequest: {
        id: receipt.paidRequestId,
        organizationId: config.organizationId,
        agentId: config.agentId,
        authContext,
        money: receipt.money,
        idempotencyKey: `openai-agents-paid-request:${config.operationId}`,
        requestUrl: merchantUrl,
        requestMethod: 'POST',
        protocol: 'x402',
      },
    },
    [`${org}/receipts/${receipt.receiptId}`]: { receipt },
    [`${org}/payment-attempts/${receipt.paymentAttemptId}`]: {
      paymentAttempt: {
        authContext,
        supportedMethod,
        money: receipt.money,
        id: receipt.paymentAttemptId,
        organizationId: config.organizationId,
        agentId: config.agentId,
        paidRequestId: receipt.paidRequestId,
        receiptId: receipt.receiptId,
        status: 'succeeded',
      },
    },
    [`${org}/audit-events`]: {
      auditEvents: [
        {
          id: id(13),
          organizationId: config.organizationId,
          paidRequestId: receipt.paidRequestId,
          receiptId: receipt.receiptId,
          paymentAttemptId: receipt.paymentAttemptId,
          eventType: 'sdk.payment_execution.succeeded',
          payload: {
            runtimeSessionId: runtime.id,
            credentialId: config.credentialId,
            agentId: config.agentId,
            idempotencyKey: `openai-agents-paid-request:${config.operationId}`,
          },
        },
      ],
    },
    '/v1/agents/sessions/session-1': { id: 'session-1', status: 'idle' },
    '/v1/agents/sessions/session-1/turns': page([
      {
        id: 'turn-1',
        agent_id: 'root-1',
        session_id: 'session-1',
        subagent_id: null,
        status: 'completed',
      },
    ]),
    '/v1/agents/sessions/session-1/subagents': page([]),
    '/v1/agents/sessions/session-1/items': page([
      {
        id: 'command-1',
        type: 'command_execution',
        turn_id: 'turn-1',
        command: "/bin/bash -lc 'node /workspace/execute-request.mjs'",
        status: 'completed',
        exit_code: 0,
        output: JSON.stringify(outcome),
      },
    ]),
  };
  let exchanged = false;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as unknown)
      : undefined;
    calls.push({ url: url.href, method, body });
    if (url.href === merchantUrl) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return challenge();
    }
    if (url.pathname === '/api/sdk/runtime-tokens') {
      exchanged = true;
      return json({ token: 'test-runtime-secret', expiresAt });
    }
    if (url.pathname === `${agent}/runtime-sessions`)
      return json({ runtimeSessions: exchanged ? [runtime] : [] });
    if (url.pathname === `${agent}/runtime-sessions/${runtime.id}/revoke`) {
      runtime.status = 'revoked';
      return json({ runtimeSession: runtime });
    }
    if (url.pathname === `${agent}/runtime-sessions/${runtime.id}`)
      return json({ runtimeSession: runtime });
    if (method === 'DELETE') return json({ deleted: true });
    if (url.pathname === '/v1/vaults' && method === 'POST')
      return json({ id: 'vault-1' });
    if (url.pathname === '/v1/vaults/vault-1/credentials' && method === 'POST')
      return json({ id: 'credential-1' });
    if (url.pathname === '/v1/agents/sessions' && method === 'POST')
      return json({ id: 'session-1' });
    if (url.pathname.endsWith('/events'))
      return new Response(null, { status: 202 });
    if (['/v1/agents', '/v1/vaults'].includes(url.pathname))
      return json(page([]));
    if (url.pathname === '/v1/models/test-model')
      return json({ id: 'test-model' });
    if (records[url.pathname]) return json(records[url.pathname]);
    throw new Error('unexpected fixture route');
  });
  return { records, fetchImpl, calls, org, agent, runtime };
}

describe('Paid request durable boundary', () => {
  it('checkpoints the real SDK request before runtime exchange or hosted creation, then revokes and deletes resources', async () => {
    const p = provider();
    const reportPath = await path();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && String(input) !== merchantUrl) {
        const saved = paidRequestReportSchema.parse(
          JSON.parse(await readFile(reportPath, 'utf8')),
        );
        expect(
          validateCheckpoint(saved.checkpoint).context.idempotencyKey,
        ).toBe(`openai-agents-paid-request:${config.operationId}`);
      }
      return p.fetchImpl(input, init);
    };
    const report = await runPaidRequest(config, secrets, reportPath, {
      fetchImpl,
      sessionBuilder: async () => ({}),
      wait: async () => undefined,
    });
    expect(report.state).toBe('passed');
    expect(report.sdkVersion).toBe(sdkClientVersion);
    expect(paidRequestReportSchema.parse({ ...report, sdkVersion: '0.1.3' }).sdkVersion)
      .toBe('0.1.3');
    expect(paidRequestReportSchema.safeParse({ ...report, sdkVersion: '../other' }).success)
      .toBe(false);
    expect(report.runtimeCleanup).toBe('revoked');
    expect(Object.values(report.cleanup)).toEqual([
      'deleted',
      'deleted',
      'deleted',
    ]);
    expect(report.controlPlaneEvidence?.verified).toBe(true);
    const saved = await readFile(reportPath, 'utf8');
    expect(saved).not.toMatch(
      /test-runtime-secret|test-bootstrap-key|test-operator-token|test-openai-key/,
    );
    await expect(
      runPaidRequest(config, secrets, reportPath, { fetchImpl }),
    ).rejects.toThrow();
  });
  it('resolves an existing key credential from the authenticated runtime session when no credential ID was supplied', async () => {
    const p = provider();
    const { credentialId: _credentialId, ...existingKeyConfig } = config;
    const report = await runPaidRequest(existingKeyConfig, secrets, await path(), {
      fetchImpl: p.fetchImpl,
      sessionBuilder: async () => ({}),
      wait: async () => undefined,
    });
    expect(report.state).toBe('passed');
    expect(report.runtimeCredentialId).toBe(config.credentialId);
    expect(report.runtimeCleanup).toBe('revoked');
    expect(p.calls.some((c) => c.url.includes('credentialId=undefined'))).toBe(
      false,
    );
  });
  it('waits for chain confirmation by reading the same receipt without repeating execution setup', async () => {
    const p = provider();
    const route = `${p.org}/receipts/${receipt.receiptId}`;
    p.records[route] = {
      receipt: { ...receipt, status: 'provisional', settlementStatus: 'reconciliation_required' },
    };
    const wait = vi.fn(async () => { p.records[route] = { receipt }; });
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: p.fetchImpl, sessionBuilder: async () => ({}), wait,
    });
    expect(report.state).toBe('passed');
    expect(wait).toHaveBeenCalledExactlyOnceWith(5000);
    expect(p.calls.filter(c => c.url.endsWith(route))).toHaveLength(2);
    for (const url of [merchantUrl, `${controlPlaneBaseUrl}/api/sdk/runtime-tokens`, 'https://api.openai.com/v1/agents/sessions'])
      expect(p.calls.filter(c => c.method === 'POST' && c.url === url)).toHaveLength(1);
    expect(report.runtimeCleanup).toBe('revoked');
    expect(Object.values(report.cleanup)).toEqual(['deleted', 'deleted', 'deleted']);
  });
  it('bounds confirmation checks and retains the paid outcome for reconciliation', async () => {
    const p = provider();
    const route = `${p.org}/receipts/${receipt.receiptId}`;
    p.records[route] = {
      receipt: { ...receipt, status: 'provisional', settlementStatus: 'reconciliation_required' },
    };
    const wait = vi.fn(async () => undefined);
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: p.fetchImpl, sessionBuilder: async () => ({}), wait,
    });
    expect(report.error).toBe('paid_request_receipt_not_confirmed');
    expect(report.outcome).toMatchObject(outcome);
    expect(wait).toHaveBeenCalledTimes(12);
    expect(p.calls.filter(c => c.url.endsWith(route))).toHaveLength(13);
    expect(p.calls.filter(c => c.method === 'POST' && c.url === merchantUrl)).toHaveLength(1);
    expect(report.runtimeCleanup).toBe('revoked');
  });
  it.each(['wrong-agent', 'failed-fulfillment', 'refunded', 'unverifiable'])(
    'does not poll or conceal %s evidence while waiting for confirmation',
    async (condition) => {
      const p = provider();
      p.records[`${p.org}/receipts/${receipt.receiptId}`] = {
        receipt: {
          ...receipt, status: 'provisional', settlementStatus: 'reconciliation_required',
          ...(condition === 'wrong-agent' ? { agentId: id(99) } : {}),
          ...(condition === 'failed-fulfillment' ? { fulfillmentStatus: 'failed' } : {}),
          ...(condition === 'refunded' ? { settlementStatus: 'refunded' } : {}),
          ...(condition === 'unverifiable' ? { settlementStatus: 'unverifiable_settlement' } : {}),
        },
      };
      const wait = vi.fn(async () => undefined);
      const report = await runPaidRequest(config, secrets, await path(), {
        fetchImpl: p.fetchImpl, sessionBuilder: async () => ({}), wait,
      });
      expect(report.state).toBe('failed');
      expect(wait).not.toHaveBeenCalled();
      expect(report.runtimeCleanup).toBe('revoked');
    },
  );
  it('honors cancellation during confirmation polling and still cleans up', async () => {
    const p = provider();
    p.records[`${p.org}/receipts/${receipt.receiptId}`] = {
      receipt: { ...receipt, status: 'provisional', settlementStatus: 'reconciliation_required' },
    };
    const controller = new AbortController();
    const wait = vi.fn(async () => { controller.abort(); });
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: p.fetchImpl, sessionBuilder: async () => ({}), wait, signal: controller.signal,
    });
    expect(report.error).toBe('paid_request_interrupted');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(report.runtimeCleanup).toBe('revoked');
    expect(Object.values(report.cleanup)).toEqual(['deleted', 'deleted', 'deleted']);
  });
  it('never exchanges credentials or launches execution when durable checkpointing fails', async () => {
    const p = provider();
    await expect(
      runPaidRequest(config, secrets, await path(), {
        fetchImpl: p.fetchImpl,
        persist: async (file, report) => {
          if ((report as { checkpoint?: unknown }).checkpoint)
            throw new Error('disk full');
          await writeReport(file, report);
        },
      }),
    ).rejects.toThrow('disk full');
    expect(
      p.calls.filter((c) => c.method === 'POST').map((c) => c.url),
    ).toEqual([merchantUrl]);
  });
  it('does not exchange credentials after interruption during the final read-only check', async () => {
    const p = provider();
    const controller = new AbortController();
    const report = await runPaidRequest(config, secrets, await path(), {
      signal: controller.signal,
      fetchImpl: async (input, init) => {
        const response = await p.fetchImpl(input, init);
        if (new URL(String(input)).pathname.endsWith('/runtime-sessions'))
          controller.abort();
        return response;
      },
    });
    expect(report.error).toBe('paid_request_interrupted');
    expect(
      p.calls.filter((c) => c.method === 'POST').map((c) => c.url),
    ).toEqual([merchantUrl]);
    expect(report.resources).toEqual({});
  });
  it('keeps a lost runtime exchange ambiguous and never retries it', async () => {
    const p = provider();
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/sdk/runtime-tokens'))
          throw new Error('lost response');
        return p.fetchImpl(input, init);
      },
    });
    expect(report.runtimeExchangePending).toBe(true);
    expect(report.runtimeCleanup).toBe('unknown');
    expect(report.state).toBe('failed');
    expect(report.resources).toEqual({});
  });
  it('retains a lost hosted creation and revokes the runtime token without creating a replacement session', async () => {
    const p = provider();
    let attempts = 0;
    const report = await runPaidRequest(config, secrets, await path(), {
      sessionBuilder: async () => ({}),
      fetchImpl: async (input, init) => {
        if (
          String(input).endsWith('/agents/sessions') &&
          init?.method === 'POST'
        ) {
          attempts++;
          throw new Error('lost response');
        }
        return p.fetchImpl(input, init);
      },
    });
    expect(attempts).toBe(1);
    expect(report.resources.pendingCreation).toBe('session');
    expect(report.runtimeCleanup).toBe('revoked');
    expect(report.state).toBe('failed');
  });
  it('rejects changed snapshots instead of silently re-preparing', async () => {
    const value = await checkpoint();
    value.prepared.request.body = 'changed';
    expect(() => validateCheckpoint(value)).toThrow();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      executeCheckpoint(value, 'placeholder', fetchImpl),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['network', 'price', 'method', 'nextAction'])(
    'rejects unsafe %s preparation',
    async (field) => {
      const value = await checkpoint();
      if (field === 'network')
        value.prepared.challengeDetails!.accepts[0]!.network = 'eip155:8453';
      if (field === 'price')
        value.prepared.challengeDetails!.accepts[0]!.amount = '1001';
      if (field === 'method') value.prepared.request.method = 'GET';
      if (field === 'nextAction') value.prepared.nextAction = 'revise_request';
      expect(() => makeCheckpoint(config, identity, value.prepared)).toThrow();
    },
  );
});
describe('Paid request SDK execution', () => {
  it('executes the saved challenge once and reads the receipt without re-probing the merchant', async () => {
    const value = await checkpoint();
    const calls: string[] = [];
    let sent: unknown;
    const result = await executeCheckpoint(
      value,
      'vault-placeholder',
      async (input, init) => {
        calls.push(String(input));
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer vault-placeholder',
        );
        expect(new Headers(init?.headers).get('x-402flow-sdk-version')).toBe(
          sdkClientVersion,
        );
        if (String(input).endsWith('/payment-decisions')) {
          sent = JSON.parse(String(init?.body));
          return json({
            outcome: 'allow',
            paidRequestId: receipt.paidRequestId,
            paymentAttemptId: receipt.paymentAttemptId,
            reasonCode: 'policy_allow',
            reason: 'fixture allow',
            merchantResponse: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"brief":"fixture"}',
            },
            receipt,
          });
        }
        return json({ receipt });
      },
    );
    expect(sent).toMatchObject({
      idempotencyKey: value.context.idempotencyKey,
      request: value.prepared.request,
      challenge: value.prepared.challenge,
    });
    expect(result.kind).toBe('success');
    expect(result.receiptVerified).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith(controlPlaneBaseUrl))).toBe(true);
  });
  it.each(['denied', 'review', 'lost-response'])(
    'preserves %s without another payment attempt',
    async (kind) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        if (kind === 'lost-response')
          throw new Error('secret transport detail');
        return json({
          outcome: 'deny',
          paidRequestId: receipt.paidRequestId,
          reasonCode:
            kind === 'review' ? 'policy_review_required' : 'policy_denied',
          reason: 'private policy text',
          ...(kind === 'review' ? { policyReviewEventId: id(16) } : {}),
        });
      });
      const result = await executeCheckpoint(
        await checkpoint(),
        'vault-placeholder',
        fetchImpl,
      );
      expect(result.kind).toBe(
        kind === 'lost-response' ? 'request_failed' : 'denied',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(/private|secret|placeholder/);
    },
  );
});
describe('Paid request operator verification', () => {
  it('accepts a larger daily budget and a deliberately smaller denial request cap independently', async () => {
    const p = provider();
    const cp = new ControlPlaneClient(secrets.operatorToken, p.fetchImpl);
    expect(await preflightPaidRequest(cp, config)).toMatchObject({
      requestPolicyRevisionId: id(22),
      budgetPolicyRevisionId: id(7),
    });
    const request = p.records[`${p.org}/policies/${config.requestPolicyId}`] as {
      policy: { definition: { maxAmount: { amountMinor: string } } };
    };
    request.policy.definition.maxAmount.amountMinor = '999';
    await expect(preflightPaidRequest(cp, { ...config, expectedOutcome: 'review' }))
      .resolves.toMatchObject({ identity });
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it.each([
    ['requestPolicyId', '1001'],
    ['budgetPolicyId', '100001'],
  ] as const)('rejects %s above its own configured ceiling', async (key, amount) => {
    const p = provider();
    const policy = p.records[`${p.org}/policies/${config[key]}`] as {
      policy: { definition: { maxAmount: { amountMinor: string } } };
    };
    policy.policy.definition.maxAmount.amountMinor = amount;
    await expect(preflightPaidRequest(
      new ControlPlaneClient(secrets.operatorToken, p.fetchImpl), config,
    )).rejects.toThrow();
  });
  it.each(['requestPolicyId', 'budgetPolicyId'] as const)(
    'rejects %s scoped to the browser agent', async (key) => {
      const p = provider();
      const policy = p.records[`${p.org}/policies/${config[key]}`] as {
        policy: { definition: { agentIds: string[] } };
      };
      policy.policy.definition.agentIds = [id(99)];
      await expect(preflightPaidRequest(
        new ControlPlaneClient(secrets.operatorToken, p.fetchImpl), config,
      )).rejects.toThrow('paid_request_policy_scope_mismatch');
    },
  );
  it('rejects a disabled per-request policy even with an active daily budget', async () => {
    const p = provider();
    const policy = p.records[`${p.org}/policies/${config.requestPolicyId}`] as {
      policy: { enabled: boolean };
    };
    policy.policy.enabled = false;
    await expect(preflightPaidRequest(
      new ControlPlaneClient(secrets.operatorToken, p.fetchImpl), config,
    )).rejects.toThrow();
  });
  it('uses only GETs for setup and rejects a disabled budget policy', async () => {
    const p = provider();
    const cp = new ControlPlaneClient(secrets.operatorToken, p.fetchImpl);
    expect((await preflightPaidRequest(cp, config)).identity).toEqual(identity);
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
    const policy = p.records[`${p.org}/policies/${config.budgetPolicyId}`] as {
      policy: { enabled: boolean };
    };
    policy.policy.enabled = false;
    await expect(preflightPaidRequest(cp, config)).rejects.toThrow();
  });
  it('rejects receipt identity mismatch even when a hosted command claims success', async () => {
    const p = provider();
    p.records[`${p.org}/receipts/${receipt.receiptId}`] = {
      receipt: { ...receipt, agentId: id(99) },
    };
    await expect(
      verifyPaymentEvidence(
        new ControlPlaneClient(secrets.operatorToken, p.fetchImpl),
        config,
        { ...outcome, kind: 'success' },
        p.runtime.id,
      ),
    ).rejects.toThrow('paid_request_evidence_identity_mismatch');
  });
  it('plans with standard SDK credentials without exposing them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(
      ['paid-plan'],
      { OPENAI_API_KEY: 'present', X402FLOW_BOOTSTRAP_KEY: 'local-key' },
    );
    expect(log.mock.calls[0]?.[0]).toContain('"bootstrapKey": true');
    expect(log.mock.calls[0]?.[0]).toContain('"workflow": "paid-request"');
    expect(log.mock.calls[0]?.[0]).not.toContain('local-key');
    await expect(mainPaidRequest('paid-run', {}, {})).rejects.toThrow(
      'paid_request_missing_operator_token',
    );
  });
});

describe('Paid request failure and evidence boundaries', () => {
  it('retains known payment IDs when the receipt lookup loses its response', async () => {
    let calls = 0;
    const result = await executeCheckpoint(
      await checkpoint(),
      'placeholder',
      async () => {
        if (calls++) throw new Error('lost receipt response');
        return json({
          outcome: 'allow',
          paidRequestId: receipt.paidRequestId,
          paymentAttemptId: receipt.paymentAttemptId,
          reasonCode: 'policy_allow',
          reason: 'fixture',
          merchantResponse: { status: 200, headers: {}, body: 'ok' },
          receipt,
        });
      },
    );
    expect(result).toMatchObject({
      kind: 'request_failed',
      paidRequestId: receipt.paidRequestId,
      paymentAttemptId: receipt.paymentAttemptId,
      receiptId: receipt.receiptId,
    });
    expect(calls).toBe(2);
  });
  it('rejects wrong hosts and merchant re-probes before sending a request', async () => {
    const transport = vi.fn<typeof fetch>();
    const guarded = createExecutionFetch(transport);
    for (const url of [
      merchantUrl,
      `${controlPlaneBaseUrl.replace('402flow.ai', '402flowXai')}/api/sdk/receipts/${id(1)}`,
      `${controlPlaneBaseUrl}/api/sdk/runtime-tokens`,
    ])
      await expect(guarded(url)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('fails cleanup visibly when runtime revocation cannot be confirmed', async () => {
    const p = provider();
    const report = await runPaidRequest(config, secrets, await path(), {
      sessionBuilder: async () => ({}),
      fetchImpl: async (input, init) =>
        String(input).endsWith('/revoke')
          ? json({}, 503)
          : p.fetchImpl(input, init),
    });
    expect(report.state).toBe('failed');
    expect(report.runtimeCleanup).toBe('failed');
    expect(report.error).toBe('paid_request_cleanup_incomplete');
    expect(Object.values(report.cleanup)).toEqual([
      'deleted',
      'deleted',
      'deleted',
    ]);
  });
  it('fails before credential exchange if the payment connection is disabled', async () => {
    const p = provider();
    p.records[`${p.org}/payment-connections`] = { paymentRails: [] };
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: p.fetchImpl,
    });
    expect(report.error).toBe('paid_request_payment_connection_not_ready');
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it.each(['denied', 'review'] as const)(
    'verifies %s through control-plane records and rejects unexpected payment evidence',
    async (expectedOutcome) => {
      const p = provider();
      const result = {
        kind: 'denied' as const,
        paidRequestId: receipt.paidRequestId,
        ...(expectedOutcome === 'review'
          ? { policyReviewEventId: id(16) }
          : {}),
      };
      p.records[`${p.org}/audit-events`] = {
        auditEvents: [
          {
            id: id(13),
            organizationId: config.organizationId,
            paidRequestId: receipt.paidRequestId,
            eventType:
              expectedOutcome === 'review'
                ? 'sdk.payment_decision.policy_review_required'
                : 'sdk.payment_decision.denied',
            payload: {
              ...authContext,
              agentId: config.agentId,
              idempotencyKey: `openai-agents-paid-request:${config.operationId}`,
            },
          },
        ],
      };
      // Staging lists are unpaginated and can exceed the normal 1 MiB limit.
      const history = [{ paidRequestId: id(99), details: 'x'.repeat(1_048_576) }];
      p.records[`${p.org}/payment-attempts`] = { paymentAttempts: history };
      p.records[`${p.org}/receipts`] = { receipts: history };
      p.records[`${p.org}/policy-review-events/${id(16)}`] = {
        policyReviewEvent: {
          id: id(16),
          organizationId: config.organizationId,
          agentId: config.agentId,
          paidRequestId: receipt.paidRequestId,
        },
      };
      const cp = new ControlPlaneClient(secrets.operatorToken, p.fetchImpl);
      expect(
        (
          await verifyPaymentEvidence(
            cp,
            { ...config, expectedOutcome },
            result,
            p.runtime.id,
          )
        ).verified,
      ).toBe(true);
      p.records[`${p.org}/payment-attempts`] = {
        paymentAttempts: [...history, { paidRequestId: receipt.paidRequestId }],
      };
      await expect(
        verifyPaymentEvidence(
          cp,
          { ...config, expectedOutcome },
          result,
          p.runtime.id,
        ),
      ).rejects.toThrow('paid_request_denial_has_payment_evidence');
      p.records[`${p.org}/payment-attempts`] = { paymentAttempts: history };
      p.records[`${p.org}/receipts`] = {
        receipts: [...history, { paidRequestId: receipt.paidRequestId }],
      };
      await expect(
        verifyPaymentEvidence(cp, { ...config, expectedOutcome }, result, p.runtime.id),
      ).rejects.toThrow('paid_request_denial_has_payment_evidence');
      expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
    },
  );
  it('bounds lifecycle history while retaining the smaller limit for detail reads', async () => {
    const cp = new ControlPlaneClient(secrets.operatorToken, async () =>
      json({ data: 'x'.repeat(16 * 1_048_576) }),
    );
    await expect(cp.request(`/organizations/${config.organizationId}/receipts`))
      .rejects.toThrow('response_too_large');
    const detail = new ControlPlaneClient(secrets.operatorToken, async () =>
      json({ data: 'x'.repeat(1_048_576) }),
    );
    await expect(detail.request(`/organizations/${config.organizationId}/receipts/${id(1)}`))
      .rejects.toThrow('response_too_large');
  });
  it.each(['operation', 'runtime', 'network', 'audit', 'simulation'])(
    'rejects mismatched %s evidence',
    async (field) => {
      const p = provider();
      const paid = p.records[
        `${p.org}/paid-requests/${receipt.paidRequestId}`
      ] as { paidRequest: Record<string, unknown> };
      if (field === 'operation')
        paid.paidRequest.idempotencyKey = 'different-operation';
      if (field === 'runtime')
        paid.paidRequest.authContext = {
          ...authContext,
          runtimeSessionId: id(99),
        };
      if (field === 'network')
        p.records[`${p.org}/receipts/${receipt.receiptId}`] = {
          receipt: {
            ...receipt,
            supportedMethod: { ...supportedMethod, network: 'base-mainnet' },
          },
        };
      if (field === 'simulation')
        p.records[`${p.org}/receipts/${receipt.receiptId}`] = {
          receipt: { ...receipt, evidenceSource: 'local_simulation' },
        };
      if (field === 'audit')
        p.records[`${p.org}/audit-events`] = { auditEvents: [] };
      await expect(
        verifyPaymentEvidence(
          new ControlPlaneClient(secrets.operatorToken, p.fetchImpl),
          config,
          { ...outcome, kind: 'success' },
          p.runtime.id,
        ),
      ).rejects.toThrow();
    },
  );
  it('refuses to send a local API credential to staging without selecting the staging URL', async () => {
    await expect(
      mainPaidRequest(
        'paid-run',
        {},
        {
          X402FLOW_BOOTSTRAP_KEY: 'local-secret',
          X402FLOW_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:3001',
          X402FLOW_ORGANIZATION: 'test-org',
          X402FLOW_AGENT: 'test-agent',
        },
      ),
    ).rejects.toThrow('paid_request_requires_staging_control_plane_url');
  });
  it('uses the existing SDK key when the staging URL and identity are explicitly selected', async () => {
    const file = await path();
    await writeFile(file, JSON.stringify(config));
    await expect(
      mainPaidRequest(
        'paid-run',
        { config: file },
        {
          X402FLOW_BOOTSTRAP_KEY: 'staging-key',
          X402FLOW_CONTROL_PLANE_BASE_URL: controlPlaneBaseUrl,
          X402FLOW_ORGANIZATION: identity.organization,
          X402FLOW_AGENT: identity.agent,
          OPERATOR_BEARER_TOKEN: 'operator-token',
        },
      ),
    ).rejects.toThrow('paid_request_requires_explicit_testnet_payment_authorization');
  });
  it.each(['standard', 'integration', 'denied'] as const)(
    'uses the dedicated agent override with %s credentials during preflight',
    async (credentialSource) => {
      const p = provider();
      const selectedAgent = credentialSource === 'denied'
        ? 'custom-denial-agent'
        : 'openai-agents-test';
      p.records[p.agent] = {
        agent: {
          id: config.agentId,
          organizationId: config.organizationId,
          externalId: selectedAgent,
          status: 'enabled',
          lifecycleStatus: 'active',
        },
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(p.fetchImpl);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const file = await path();
      await writeFile(file, JSON.stringify(config));
      await mainPaidRequest('paid-preflight', {
        config: file,
        ...(credentialSource === 'denied' ? { 'agent-profile': 'denied' } : {}),
      }, {
        X402FLOW_ORGANIZATION: identity.organization,
        X402FLOW_AGENT: 'test-agent',
        OPENAI_AGENTS_AGENT: 'openai-agents-test',
        OPERATOR_BEARER_TOKEN: secrets.operatorToken,
        ...(credentialSource === 'standard'
          ? {
              X402FLOW_BOOTSTRAP_KEY: secrets.bootstrapKey,
              X402FLOW_CONTROL_PLANE_BASE_URL: controlPlaneBaseUrl,
            }
          : credentialSource === 'integration' ? {
              OPENAI_AGENTS_BOOTSTRAP_KEY: secrets.bootstrapKey,
              X402FLOW_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:3001',
            } : {
              OPENAI_AGENTS_DENIED_AGENT: selectedAgent,
              OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY: secrets.bootstrapKey,
              X402FLOW_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:3001',
            }),
      });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        readOnly: true,
        setup: { identity: { ...identity, agent: selectedAgent } },
      });
      expect(p.calls.length).toBeGreaterThan(0);
      expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
    },
  );
  it.each(['success', 'denied'] as const)(
    'exchanges only the %s profile key when both pairs are configured, without retrying a rejected exchange',
    async (agentProfile) => {
      const p = provider();
      const selectedAgent = agentProfile === 'denied'
        ? 'custom-denial-agent'
        : 'openai-agents-test';
      p.records[p.agent] = {
        agent: {
          id: config.agentId,
          organizationId: config.organizationId,
          externalId: selectedAgent,
          status: 'enabled',
          lifecycleStatus: 'active',
        },
      };
      const exchangeHeaders: Array<string | null> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).endsWith('/sdk/runtime-tokens')) {
          exchangeHeaders.push(new Headers(init?.headers).get('authorization'));
          return json({}, 401);
        }
        return p.fetchImpl(input, init);
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const runConfig = { ...config, operationId: randomUUID() };
      const file = await path();
      await writeFile(file, JSON.stringify(runConfig));
      const reportPath = join(process.cwd(), 'tmp/openai-agents-api/paid-requests', `${runConfig.operationId}.json`);
      dirs.push(reportPath);
      await main([
        'paid-run', '--config', file, '--allow-testnet-payment',
        ...(agentProfile === 'denied' ? ['--agent-profile', 'denied'] : []),
      ], {
        OPENAI_API_KEY: secrets.openaiKey,
        X402FLOW_ORGANIZATION: identity.organization,
        X402FLOW_AGENT: identity.agent,
        X402FLOW_BOOTSTRAP_KEY: 'browser-only-secret',
        X402FLOW_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:3001',
        OPENAI_AGENTS_AGENT: 'openai-agents-test',
        OPENAI_AGENTS_BOOTSTRAP_KEY: 'success-only-secret',
        OPENAI_AGENTS_DENIED_AGENT: 'custom-denial-agent',
        OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY: 'denied-only-secret',
        OPENAI_AGENTS_OPERATOR_TOKEN: secrets.operatorToken,
      });
      expect(exchangeHeaders).toEqual([
        `Bearer ${agentProfile === 'denied' ? 'denied-only-secret' : 'success-only-secret'}`,
      ]);
      const saved = await readFile(reportPath, 'utf8');
      expect(JSON.parse(saved)).toMatchObject({
        state: 'failed', error: 'paid_request_runtime_exchange_failed',
        checkpoint: { identity: { ...identity, agent: selectedAgent } },
      });
      expect(p.calls.filter((c) => c.method !== 'GET').map((c) => c.url)).toEqual([merchantUrl]);
      expect(saved + JSON.stringify(log.mock.calls)).not.toMatch(
        /browser-only-secret|success-only-secret|denied-only-secret/,
      );
    },
  );
  it.each([undefined, ''])(
    'does not use another profile key when the denial key is %s',
    async (deniedKey) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const file = await path();
      await writeFile(file, JSON.stringify(config));
      await expect(mainPaidRequest('paid-run', {
        config: file, 'agent-profile': 'denied', 'allow-testnet-payment': true,
      }, {
        OPENAI_API_KEY: secrets.openaiKey,
        X402FLOW_ORGANIZATION: identity.organization,
        X402FLOW_AGENT: identity.agent,
        X402FLOW_BOOTSTRAP_KEY: 'browser-only-secret',
        OPENAI_AGENTS_AGENT: 'openai-agents-test',
        OPENAI_AGENTS_BOOTSTRAP_KEY: secrets.bootstrapKey,
        OPENAI_AGENTS_DENIED_AGENT: 'openai-agents-denied-test',
        ...(deniedKey === undefined ? {} : { OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY: deniedKey }),
        OPENAI_AGENTS_OPERATOR_TOKEN: secrets.operatorToken,
      })).rejects.toThrow('paid_request_missing_credentials');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
  it('requires the denial profile identity and rejects unknown profile names before network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = {
      X402FLOW_ORGANIZATION: identity.organization,
      X402FLOW_AGENT: identity.agent,
      OPENAI_AGENTS_AGENT: 'openai-agents-test',
      OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY: secrets.bootstrapKey,
      OPENAI_AGENTS_OPERATOR_TOKEN: secrets.operatorToken,
    };
    await expect(main(['paid-preflight', '--agent-profile', 'denied'], env))
      .rejects.toThrow('paid_request_requires_sdk_identity');
    await expect(main(['paid-plan', '--agent-profile', 'typo'], env))
      .rejects.toThrow('paid_request_invalid_agent_profile');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('reports the selected denial profile without exposing either credential', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(['paid-plan', '--agent-profile', 'denied'], {
      OPENAI_AGENTS_AGENT: 'openai-agents-test',
      OPENAI_AGENTS_BOOTSTRAP_KEY: 'success-only-secret',
      OPENAI_AGENTS_DENIED_AGENT: 'custom-denial-agent',
      OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY: 'denied-only-secret',
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      agentProfile: 'denied',
      configured: { agent: true, bootstrapKey: true, bootstrapSource: 'denied_integration_override' },
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/success-only-secret|denied-only-secret/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects the browser agent in config when the dedicated agent is selected', async () => {
    const p = provider();
    vi.spyOn(globalThis, 'fetch').mockImplementation(p.fetchImpl);
    const file = await path();
    await writeFile(file, JSON.stringify(config));
    await expect(mainPaidRequest('paid-preflight', { config: file }, {
      X402FLOW_ORGANIZATION: identity.organization,
      X402FLOW_AGENT: identity.agent,
      OPENAI_AGENTS_AGENT: 'openai-agents-test',
      OPENAI_AGENTS_BOOTSTRAP_KEY: secrets.bootstrapKey,
      OPENAI_AGENTS_OPERATOR_TOKEN: secrets.operatorToken,
    })).rejects.toThrow('paid_request_configured_identity_mismatch');
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('requires an organization for the dedicated agent override before any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(mainPaidRequest('paid-preflight', {}, {
      OPENAI_AGENTS_AGENT: 'openai-agents-test',
      OPENAI_AGENTS_BOOTSTRAP_KEY: secrets.bootstrapKey,
      OPENAI_AGENTS_OPERATOR_TOKEN: secrets.operatorToken,
    })).rejects.toThrow('paid_request_requires_sdk_identity');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects a mismatch between SDK environment identity and operator config before probing or exchange', async () => {
    const p = provider();
    const report = await runPaidRequest(config, secrets, await path(), {
      fetchImpl: p.fetchImpl,
      expectedIdentity: { ...identity, agent: 'another-agent' },
    });
    expect(report.error).toBe('paid_request_configured_identity_mismatch');
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('requires an explicit payment flag even with valid configuration', async () => {
    const file = await path();
    await writeFile(file, JSON.stringify(config));
    await expect(
      mainPaidRequest(
        'paid-run',
        { config: file },
        { OPENAI_AGENTS_OPERATOR_TOKEN: 'fixture' },
      ),
    ).rejects.toThrow('paid_request_requires_explicit_testnet_payment_authorization');
  });
});
