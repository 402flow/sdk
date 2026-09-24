import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkAccess,
  cleanupReport,
  OpenAiProbeApi,
  probeDefaults,
  runProbe,
  validateConfig,
  withReportLock,
} from './probe.js';
import { ProbeError } from './transport.js';

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'canary-url': { type: 'string' },
      report: { type: 'string' },
      config: { type: 'string' },
      'allow-testnet-payment': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'plan';
  if (values.help) {
    console.log(
      'Usage: npm run example:openai-agents-api -- plan|preflight|run|cleanup [--model ID] [--canary-url HTTPS_URL] [--report PATH]; paid-plan|paid-preflight|paid-run --config PATH [--allow-testnet-payment]; paid-cleanup|paid-reconcile --report PATH',
    );
    return;
  }
  if (command.startsWith('paid-') && positionals.length === 1) {
    const { mainPaidRequest } = await import('./paid-request-cli.js');
    await mainPaidRequest(command, values, env);
    return;
  }
  if (
    positionals.length > 1 ||
    !['plan', 'preflight', 'run', 'cleanup'].includes(command)
  )
    throw new ProbeError('invalid_command');
  const model = values.model ?? env.OPENAI_AGENTS_MODEL;
  const canaryUrl = values['canary-url'] ?? env.OPENAI_AGENTS_CANARY_URL;
  if (command === 'plan') {
    // Do not print environment values, request bodies, or credentials.
    console.log(
      JSON.stringify(
        {
          stage: 1,
          networkCalls: 0,
          paidRequests: 0,
          sdk: '0.1.3',
          configured: {
            apiKey: Boolean(env.OPENAI_API_KEY),
            model: Boolean(model),
            canaryUrl: Boolean(canaryUrl),
          },
          hostedActors: ['root', 'child-a', 'child-b'],
          routes: probeDefaults,
          next: 'preflight, then run with an approved model and canary URL',
        },
        null,
        2,
      ),
    );
    return;
  }
  const key = env.OPENAI_API_KEY;
  if (!key) throw new ProbeError('missing_openai_api_key');
  const api = new OpenAiProbeApi(key);
  if (command === 'preflight') {
    const access = await checkAccess(api, model);
    console.log(
      JSON.stringify(
        { readOnly: true, access, hostedValidated: false },
        null,
        2,
      ),
    );
    if (Object.values(access).some((status) => status !== 'accessible'))
      process.exitCode = 1;
    return;
  }
  if (command === 'cleanup') {
    if (!values.report) throw new ProbeError('cleanup_requires_report');
    const reportPath = resolve(values.report);
    const report = await withReportLock(reportPath, () =>
      cleanupReport(reportPath, api),
    );
    console.log(
      JSON.stringify({
        state: report.state,
        cleanup: report.cleanup,
        pendingCreation: report.resources.pendingCreation ?? null,
      }),
    );
    if (
      report.resources.pendingCreation ||
      Object.values(report.cleanup).includes('failed')
    )
      process.exitCode = 1;
    return;
  }
  if (!model || !canaryUrl)
    throw new ProbeError('run_requires_model_and_approved_canary_url');
  const runId = randomUUID();
  const config = validateConfig({ runId, model, canaryUrl, ...probeDefaults });
  const reportPath = resolve(
    values.report ?? `tmp/openai-agents-api/${runId}.json`,
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const report = await withReportLock(reportPath, () =>
      runProbe(config, key, reportPath, { signal: controller.signal }),
    );
    console.log(
      JSON.stringify({
        state: report.state,
        error: report.error,
        report: reportPath,
        cleanup: report.cleanup,
      }),
    );
    if (report.state !== 'passed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
