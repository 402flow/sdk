import { hostedSdk, sdkVersionSchema } from './hosted-sdk.js';
import { open, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AgentPayClient, sdkClientVersion } from '@402flow/sdk';
import {
  checkAccess,
  cleanupResources,
  OpenAiProbeApi,
  resourcesSchema,
  writeReport,
} from './probe.js';
import { ProbeError, requestText } from './transport.js';
import {
  checkpointSchema,
  makeCheckpoint,
  requestBody,
  paidRequestConfigSchema,
  merchantUrl,
  controlPlaneBaseUrl,
  paidRequestOutcomeSchema,
  validateCheckpoint,
  type PaidRequestConfig,
  type PaidRequestIdentity,
} from './paid-request-contract.js';
import {
  exchangeRuntimeToken,
  runtimeSessions,
  revokeRuntimeSession,
  ControlPlaneClient,
  preflightPaidRequest,
  verifyPaymentEvidence,
} from './control-plane.js';
const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const paidRequestReportSchema = z
  .object({
    workflow: z.literal('paid-request'),
    schemaVersion: z.literal(1),
    sdkVersion: sdkVersionSchema,
    sdkArtifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    config: paidRequestConfigSchema,
    startedAt: z.string().datetime(),
    state: z.enum(['running', 'passed', 'failed']),
    checkpoint: checkpointSchema.optional(),
    setup: z
      .object({
        identity: z.object({ organization: z.string(), agent: z.string() }),
        posture: z.string(),
        requestPolicyRevisionId: z.string().uuid(),
        budgetPolicyRevisionId: z.string().uuid(),
        walletId: z.string().uuid(),
        paymentConnectionId: z.string().uuid(),
      })
      .optional(),
    resources: resourcesSchema.strict(),
    runtimeExchangePending: z.boolean(),
    runtimeSessionsBefore: z.array(z.string().uuid()),
    runtimeSessionId: z.string().uuid().optional(),
    runtimeCredentialId: z.string().uuid().optional(),
    runtimeExpiresAt: z.string().datetime().optional(),
    outcome: paidRequestOutcomeSchema.optional(),
    providerEvidence: z
      .object({
        commandId: providerId,
        turnId: providerId,
        agentId: providerId,
      })
      .optional(),
    controlPlaneEvidence: z
      .object({
        verified: z.literal(true),
        auditEventIds: z.array(z.string().uuid()),
      })
      .optional(),
    runtimeCleanup: z.enum(['not_created', 'revoked', 'failed', 'unknown']),
    cleanup: z.record(z.enum(['deleted', 'failed'])),
    error: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
  })
  .strict();
export type PaidRequestReport = z.infer<typeof paidRequestReportSchema>;
export type PaidRequestSecrets = {
  openaiKey: string;
  bootstrapKey: string;
  operatorToken: string;
};
export async function buildPaidRequestSession(
  checkpoint: unknown,
  vaultId: string,
  model: string,
) {
  const artifact = await hostedSdk();
  const files = [artifact.file];
  for (const name of [
    'execute-request',
    'paid-request-contract',
    'sandbox-probe',
    'transport',
  ]) {
    const source = await readFile(
      new URL(`./${name}.js`, import.meta.url),
      'utf8',
    );
    files.push({
      type: 'inline',
      path: `/workspace/${name}.mjs`,
      data: Buffer.from(
        source.replace(/(['"])\.\/([a-z0-9-]+)\.js\1/g, "'./$2.mjs'"),
      ).toString('base64'),
    });
  }
  files.push({
    type: 'inline',
    path: '/workspace/checkpoint.json',
    data: Buffer.from(JSON.stringify(validateCheckpoint(checkpoint))).toString(
      'base64',
    ),
  });
  return {
    metadata: {
      sdk_artifact_sha256: artifact.sha256,
      reference_workflow: 'paid-request',
      operation_id: validateCheckpoint(checkpoint).config.operationId,
    },
    agent: {
      model,
      instructions:
        'Run only the exact supplied command once. Do not inspect credentials, change files, install packages, retry, or issue any other command or network request. Report failure without repair.',
      multi_agent: { enabled: false },
    },
    environment: {
      type: 'openai_hosted',
      network: {
        access: 'restricted',
        allowed_domains: [new URL(controlPlaneBaseUrl).hostname],
      },
      packages: artifact.packages,
      setup_commands: artifact.setup_commands,
      files,
    },
    vault_ids: [vaultId],
    input:
      'Run exactly `node /workspace/execute-request.mjs` once, then finish. The supplied checkpoint was already durably saved by the trusted launcher. Do not prepare again or create subagents.',
  };
}
export async function collectPaidRequestOutcome(
  api: OpenAiProbeApi,
  id: string,
  wait: (ms: number) => Promise<unknown> = delay,
) {
  const path = `/agents/sessions/${id}`;
  for (;;) {
    const session = z
      .object({ id: providerId, status: z.string() })
      .parse(await api.request(path));
    if (session.id !== id || session.status === 'failed')
      throw new ProbeError('paid_request_session_failed');
    const turns = (await api.list(`${path}/turns`)).map((v) =>
      z
        .object({
          id: providerId,
          agent_id: providerId,
          session_id: providerId,
          subagent_id: providerId.nullable(),
          status: z.string(),
        })
        .parse(v),
    );
    if (
      turns.length > 1 ||
      turns.some((t) => t.session_id !== id || t.subagent_id !== null)
    )
      throw new ProbeError('paid_request_unexpected_turns');
    const turn = turns[0];
    if (turn?.status === 'failed' || turn?.status === 'cancelled')
      throw new ProbeError('paid_request_turn_failed');
    if (turn?.status === 'completed') {
      if ((await api.list(`${path}/subagents`)).length)
        throw new ProbeError('paid_request_unexpected_subagents');
      const commands = (await api.list(`${path}/items`)).filter(
        (item) =>
          z.object({ type: z.string() }).parse(item).type ===
          'command_execution',
      );
      if (commands.length !== 1)
        throw new ProbeError('paid_request_unexpected_commands');
      const command = z
        .object({
          id: providerId,
          turn_id: providerId,
          command: z.string(),
          exit_code: z.literal(0),
          status: z.literal('completed'),
          output: z.string(),
        })
        .parse(commands[0]);
      if (
        command.turn_id !== turn.id ||
        ![
          'node /workspace/execute-request.mjs',
          "/bin/bash -lc 'node /workspace/execute-request.mjs'",
        ].includes(command.command.trim())
      )
        throw new ProbeError('paid_request_command_mismatch');
      return {
        outcome: paidRequestOutcomeSchema.parse(JSON.parse(command.output)),
        providerEvidence: {
          commandId: command.id,
          turnId: turn.id,
          agentId: turn.agent_id,
        },
      };
    }
    await wait(2000);
  }
}
export async function cleanupPaidRequest(
  report: PaidRequestReport,
  secrets: PaidRequestSecrets,
  fetchImpl: typeof fetch = fetch,
) {
  // Revoke capability first; cancellation/deletion is not payment reconciliation.
  if (report.runtimeSessionId) {
    try {
      await revokeRuntimeSession(
        new ControlPlaneClient(secrets.operatorToken, fetchImpl),
        report.config,
        report.runtimeSessionId,
        report.runtimeCredentialId,
      );
      report.runtimeCleanup = 'revoked';
    } catch {
      report.runtimeCleanup = 'failed';
    }
  } else if (report.runtimeExchangePending) report.runtimeCleanup = 'unknown';
  report.cleanup = await cleanupResources(
    new OpenAiProbeApi(secrets.openaiKey, [], fetchImpl),
    report.resources,
  );
  if (
    report.runtimeExchangePending ||
    report.resources.pendingCreation ||
    ['failed', 'unknown'].includes(report.runtimeCleanup) ||
    Object.values(report.cleanup).includes('failed')
  ) {
    report.state = 'failed';
    report.error ??= 'paid_request_cleanup_incomplete';
  }
}
export async function runPaidRequest(
  config: PaidRequestConfig,
  secrets: PaidRequestSecrets,
  path: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: (ms: number) => Promise<unknown>;
    sessionBuilder?: (
      ...args: Parameters<typeof buildPaidRequestSession>
    ) => Promise<unknown>;
    signal?: AbortSignal;
    persist?: typeof writeReport;
    expectedIdentity?: PaidRequestIdentity;
  } = {},
) {
  paidRequestConfigSchema.parse(config);
  if (Object.values(secrets).some((v) => !v))
    throw new ProbeError('paid_request_missing_credentials');
  const persist = options.persist ?? writeReport;
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: PaidRequestReport = {
    workflow: 'paid-request',
    schemaVersion: 1,
    sdkVersion: sdkClientVersion,
    config,
    startedAt: new Date().toISOString(),
    state: 'running',
    resources: {},
    runtimeExchangePending: false,
    runtimeSessionsBefore: [],
    runtimeCleanup: 'not_created',
    cleanup: {},
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const reservation = await open(path, 'wx', 0o600);
  await reservation.close();
  await persist(path, report);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  options.signal?.addEventListener('abort', interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  const timer = setTimeout(interrupt, 300_000);
  const secretValues = [
    secrets.openaiKey,
    secrets.bootstrapKey,
    secrets.operatorToken,
  ];
  const api = new OpenAiProbeApi(
    secrets.openaiKey,
    secretValues,
    fetchImpl,
    controller.signal,
  );
  const cp = new ControlPlaneClient(
    secrets.operatorToken,
    fetchImpl,
    secretValues,
  );
  const create = async (
    kind: 'vault' | 'credential' | 'session',
    route: string,
    body: unknown,
  ) => {
    controller.signal.throwIfAborted();
    report.resources.pendingCreation = kind;
    await persist(path, report);
    const result = z
      .object({ id: providerId })
      .parse(await api.request(route, 'POST', body));
    report.resources[`${kind}Id`] = result.id;
    delete report.resources.pendingCreation;
    await persist(path, report);
    return result.id;
  };
  try {
    report.setup = await preflightPaidRequest(cp, config);
    if (
      options.expectedIdentity &&
      (report.setup.identity.organization !==
        options.expectedIdentity.organization ||
        report.setup.identity.agent !== options.expectedIdentity.agent)
    )
      throw new ProbeError('paid_request_configured_identity_mismatch');
    const access = await checkAccess(api, config.model);
    if (Object.values(access).some((v) => v !== 'accessible'))
      throw new ProbeError('paid_request_openai_access_failed');
    const merchantFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (
        url !== merchantUrl ||
        new Headers(init?.headers).has('authorization')
      )
        throw new ProbeError('paid_request_unexpected_prepare_route');
      const r = await requestText(
        fetchImpl,
        url,
        init ?? {},
        15_000,
        65_536,
        controller.signal,
      );
      return new Response(r.text, { status: r.status, headers: r.headers });
    };
    const client = new AgentPayClient({
      controlPlaneBaseUrl,
      ...report.setup.identity,
      auth: { type: 'runtimeToken', runtimeToken: 'unpaid-prepare-only' },
      fetch: merchantFetch,
    });
    const prepared = await client.preparePaidRequest(merchantUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
    report.checkpoint = makeCheckpoint(config, report.setup.identity, prepared);
    await persist(path, report); // Durable acknowledgement BEFORE credential delivery/execution.
    controller.signal.throwIfAborted();
    report.runtimeSessionsBefore = (await runtimeSessions(cp, config)).map(
      (v) => v.id,
    );
    report.runtimeExchangePending = true;
    await persist(path, report);
    controller.signal.throwIfAborted();
    const runtime = await exchangeRuntimeToken(
      secrets.bootstrapKey,
      fetchImpl,
    );
    secretValues.push(runtime.token);
    const created = (await runtimeSessions(cp, config)).filter(
      (v) => !report.runtimeSessionsBefore.includes(v.id),
    );
    if (created.length !== 1)
      throw new ProbeError('paid_request_runtime_exchange_ambiguous');
    const session = created[0]!;
    report.runtimeSessionId = session.id;
    report.runtimeCredentialId = session.credentialId;
    report.runtimeExpiresAt = runtime.expiresAt;
    await persist(path, report);
    if (
      session.organizationId !== config.organizationId ||
      session.agentId !== config.agentId ||
      (config.credentialId !== undefined &&
        session.credentialId !== config.credentialId) ||
      session.status !== 'active' ||
      !session.scope.includes('sdk') ||
      session.expiresAt !== runtime.expiresAt ||
      Date.parse(runtime.expiresAt) < Date.now() + 360_000
    )
      throw new ProbeError('paid_request_runtime_identity_mismatch');
    report.runtimeExchangePending = false;
    await persist(path, report);
    const vaultId = await create('vault', '/vaults', {
      name: `402flow-openai-paid-${config.operationId}`,
    });
    await create('credential', `/vaults/${vaultId}/credentials`, {
      name: `402flow-openai-paid-${config.operationId}`,
      auth: {
        type: 'environment_variable',
        secret_name: 'X402FLOW_RUNTIME_TOKEN',
        secret_value: runtime.token,
        networking: {
          type: 'limited',
          allowed_hosts: [new URL(controlPlaneBaseUrl).hostname],
        },
      },
    });
    // The only authenticated hosted work starts after the checkpoint is durable.
    const payload = await (options.sessionBuilder ?? buildPaidRequestSession)(
      report.checkpoint,
      vaultId,
      config.model,
    );
    const artifact = z
      .object({
        metadata: z
          .object({ sdk_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
          .optional(),
      })
      .parse(payload);
    report.sdkArtifactSha256 = artifact.metadata?.sdk_artifact_sha256;
    const sessionId = await create('session', '/agents/sessions', payload);
    Object.assign(
      report,
      await collectPaidRequestOutcome(api, sessionId, options.wait),
    );
    await persist(path, report);
    for (let confirmationCheck = 0; ; confirmationCheck++) {
      controller.signal.throwIfAborted();
      try {
        report.controlPlaneEvidence = await verifyPaymentEvidence(
          cp, config, report.outcome!, session.id, session.credentialId,
        );
        break;
      } catch (error) {
        if (
          !(error instanceof ProbeError) ||
          error.code !== 'paid_request_receipt_confirmation_pending'
        )
          throw error;
        if (confirmationCheck >= 12)
          throw new ProbeError('paid_request_receipt_not_confirmed');
        // Re-read the same operation only; never exchange, prepare, or execute again.
        if (options.wait) await options.wait(5000);
        else await delay(5000, undefined, { signal: controller.signal });
      }
    }
    report.state = 'passed';
  } catch (error) {
    report.state = 'failed';
    report.error = controller.signal.aborted
      ? 'paid_request_interrupted'
      : error instanceof ProbeError
        ? error.code
        : 'paid_request_validation_failed';
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', interrupt);
    await cleanupPaidRequest(report, secrets, fetchImpl);
    await persist(path, report);
  }
  return report;
}
