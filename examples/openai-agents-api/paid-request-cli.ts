import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { sdkClientVersion } from '@402flow/sdk';
import { ProbeError } from './transport.js';
import { withReportLock, writeReport } from './probe.js';
import {
  controlPlaneBaseUrl,
  paidRequestConfigSchema,
  validateCheckpoint,
} from './paid-request-contract.js';
import {
  ControlPlaneClient,
  preflightPaidRequest,
  orgPath,
} from './control-plane.js';
import {
  cleanupPaidRequest,
  runPaidRequest,
  paidRequestReportSchema,
} from './paid-request.js';
async function readJson(path: string) {
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) throw new ProbeError('paid_request_file_too_large');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export async function mainPaidRequest(
  command: string,
  values: {
    config?: string;
    report?: string;
    'allow-testnet-payment'?: boolean;
    'agent-profile'?: string;
  },
  env: NodeJS.ProcessEnv,
) {
  const agentProfile = values['agent-profile'] ?? 'success';
  if (!['success', 'denied'].includes(agentProfile))
    throw new ProbeError('paid_request_invalid_agent_profile');
  const useDeniedAgent = agentProfile === 'denied';
  const configuredAgent = useDeniedAgent
    ? env.OPENAI_AGENTS_DENIED_AGENT
    : env.OPENAI_AGENTS_AGENT ?? env.X402FLOW_AGENT;
  const integrationBootstrapKey = useDeniedAgent
    ? env.OPENAI_AGENTS_DENIED_BOOTSTRAP_KEY
    : env.OPENAI_AGENTS_BOOTSTRAP_KEY;
  const secrets = {
    openaiKey: env.OPENAI_API_KEY ?? '',
    bootstrapKey:
      integrationBootstrapKey ??
      (useDeniedAgent ? '' : env.X402FLOW_BOOTSTRAP_KEY ?? ''),
    operatorToken:
      env.OPENAI_AGENTS_OPERATOR_TOKEN ??
      env.OPERATOR_BEARER_TOKEN ??
      '',
  };
  const useStandardConfig =
    !useDeniedAgent &&
    !integrationBootstrapKey &&
    Boolean(env.X402FLOW_BOOTSTRAP_KEY);
  const stagingTarget =
    env.X402FLOW_CONTROL_PLANE_BASE_URL?.replace(/\/$/, '') ===
    controlPlaneBaseUrl;
  const requireConfiguredIdentity =
    useDeniedAgent || useStandardConfig || env.OPENAI_AGENTS_AGENT !== undefined;
  const expectedIdentity =
    requireConfiguredIdentity && env.X402FLOW_ORGANIZATION && configuredAgent
      ? { organization: env.X402FLOW_ORGANIZATION, agent: configuredAgent }
      : undefined;
  if (command === 'paid-plan') {
    console.log(
      JSON.stringify(
        {
          workflow: 'paid-request',
          networkCalls: 0,
          paidRequests: 0,
          sdk: sdkClientVersion,
          agentProfile,
          configured: {
            agent: Boolean(configuredAgent),
            openaiKey: Boolean(secrets.openaiKey),
            bootstrapKey: Boolean(secrets.bootstrapKey),
            operatorToken: Boolean(secrets.operatorToken),
            bootstrapSource: integrationBootstrapKey !== undefined
              ? useDeniedAgent
                ? 'denied_integration_override'
                : 'integration_override'
              : useStandardConfig
                ? 'sdk_configuration'
                : 'missing',
            stagingTarget,
          },
          required:
            'Config with organization, agent, request-policy and budget-policy UUIDs (optional credential UUID); new operation UUID; expected outcome; per-request maximum of 1000 Base Sepolia USDC minor units and a separate maxBudgetAmountMinor. Run paid-preflight before paid-run.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (['paid-preflight', 'paid-run'].includes(command)) {
    if (useStandardConfig && !stagingTarget)
      throw new ProbeError('paid_request_requires_staging_control_plane_url');
    if (requireConfiguredIdentity && !expectedIdentity)
      throw new ProbeError('paid_request_requires_sdk_identity');
  }
  if (!secrets.operatorToken)
    throw new ProbeError('paid_request_missing_operator_token');
  const cp = new ControlPlaneClient(secrets.operatorToken);
  if (command === 'paid-cleanup' || command === 'paid-reconcile') {
    if (!values.report) throw new ProbeError('paid_request_requires_report');
    const path = resolve(values.report);
    await withReportLock(path, async () => {
      const report = paidRequestReportSchema.parse(await readJson(path));
      if (report.checkpoint) validateCheckpoint(report.checkpoint);
      if (command === 'paid-cleanup') {
        if (!secrets.openaiKey) throw new ProbeError('missing_openai_api_key');
        await cleanupPaidRequest(report, secrets);
        if (report.state === 'running') {
          report.state = 'failed';
          report.error ??= 'paid_request_interrupted';
        }
        await writeReport(path, report);
        console.log(
          JSON.stringify({
            runtimeCleanup: report.runtimeCleanup,
            cleanup: report.cleanup,
            runtimeExchangePending: report.runtimeExchangePending,
            pendingCreation: report.resources.pendingCreation ?? null,
          }),
        );
        if (
          report.runtimeExchangePending ||
          report.resources.pendingCreation ||
          ['failed', 'unknown'].includes(report.runtimeCleanup) ||
          Object.values(report.cleanup).includes('failed')
        )
          process.exitCode = 1;
      } else {
        const result = z
          .object({
            paidRequests: z.array(
              z.object({
                id: z.string().uuid(),
                organizationId: z.string().uuid(),
                agentId: z.string().uuid(),
                idempotencyKey: z.string().optional(),
                state: z.string(),
                receiptId: z.string().uuid().optional(),
              }),
            ),
          })
          .parse(await cp.request(`${orgPath(report.config)}/paid-requests`));
        const matches = result.paidRequests
          .filter(
            (v) =>
              v.idempotencyKey ===
                `openai-agents-paid-request:${report.config.operationId}` &&
              v.organizationId === report.config.organizationId &&
              v.agentId === report.config.agentId,
          )
          .map((v) => ({
            paidRequestId: v.id,
            receiptId: v.receiptId,
            state: [
              'created',
              'evaluating',
              'denied',
              'executing',
              'succeeded',
              'failed',
              'inconclusive',
              'completed',
            ].includes(v.state)
              ? v.state
              : 'inspect_control_plane',
          }));
        console.log(
          JSON.stringify({
            readOnly: true,
            matches,
            retryAuthorized: false,
            note: 'An absent record is not proof that payment did not occur. Inspect the checkpoint and control-plane state; this command never re-probes, exchanges credentials, or executes.',
          }),
        );
      }
    });
    return;
  }
  if (!values.config) throw new ProbeError('paid_request_requires_config');
  const config = paidRequestConfigSchema.parse(
    await readJson(resolve(values.config)),
  );
  if (command === 'paid-preflight') {
    const setup = await preflightPaidRequest(cp, config);
    if (
      expectedIdentity &&
      (setup.identity.organization !== expectedIdentity.organization ||
        setup.identity.agent !== expectedIdentity.agent)
    )
      throw new ProbeError('paid_request_configured_identity_mismatch');
    console.log(JSON.stringify({ readOnly: true, setup }, null, 2));
    return;
  }
  if (command !== 'paid-run') throw new ProbeError('invalid_command');
  if (!values['allow-testnet-payment'])
    throw new ProbeError(
      'paid_request_requires_explicit_testnet_payment_authorization',
    );
  if (values.report)
    throw new ProbeError('paid_request_run_uses_operation_report_path');
  const path = resolve(
    `tmp/openai-agents-api/paid-requests/${config.operationId}.json`,
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const report = await withReportLock(path, () =>
      runPaidRequest(config, secrets, path, {
        signal: controller.signal,
        ...(expectedIdentity ? { expectedIdentity } : {}),
      }),
    );
    console.log(
      JSON.stringify({
        state: report.state,
        error: report.error,
        report: path,
        outcome: report.outcome,
        runtimeCleanup: report.runtimeCleanup,
        cleanup: report.cleanup,
      }),
    );
    if (report.state !== 'passed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
