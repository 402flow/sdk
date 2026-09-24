import { hostedSdk } from './hosted-sdk.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import { hashAuthorization, type ProbeConfig } from './sandbox-probe.js';
import { ProbeError, requestText } from './transport.js';
export { ProbeError } from './transport.js';

export const actors = ['root', 'child-a', 'child-b'] as const;
const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const createdSchema = z.object({ id: idSchema });
const pageSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z.boolean(),
  last_id: idSchema.nullable().optional(),
});
const turnSchema = z.object({
  id: idSchema,
  agent_id: idSchema,
  session_id: idSchema,
  subagent_id: idSchema.nullable(),
  status: z.string(),
});
const commandSchema = z.object({
  id: idSchema,
  type: z.literal('command_execution'),
  command: z.string(),
  turn_id: idSchema,
  status: z.literal('completed'),
  exit_code: z.literal(0),
  output: z.string(),
});
const resultSchema = z
  .object({
    runId: idSchema,
    actor: z.enum(actors),
    nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    checks: z
      .object({
        nodeSupported: z.boolean(),
        sdkPlaceholderHeader: z.boolean(),
        secretHidden: z.boolean(),
        vaultSubstitution: z.boolean(),
        apiReachable: z.boolean(),
        merchantChallenge: z.boolean(),
        blockedDestinationRejected: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const resourcesSchema = z.object({
  vaultId: idSchema.optional(),
  credentialId: idSchema.optional(),
  sessionId: idSchema.optional(),
  pendingCreation: z.enum(['vault', 'credential', 'session']).optional(),
});
type Resources = z.infer<typeof resourcesSchema>;
const configSchema = z
  .object({
    runId: idSchema,
    model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
    canaryUrl: z.string(),
    apiHealthUrl: z.string(),
    merchantUrl: z.string(),
    blockedUrl: z.string(),
  })
  .strict();
export const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    versions: z
      .object({
        sdk: z.enum(['0.1.2', '0.1.3']),
        openAiBeta: z.literal('agents=v1'),
      })
      .strict(),
    config: configSchema,
    startedAt: z.string().datetime(),
    state: z.enum(['running', 'passed', 'failed']),
    resources: resourcesSchema.strict(),
    evidence: z.array(
      z
        .object({
          result: resultSchema,
          commandId: idSchema,
          turnId: idSchema,
          subagentId: idSchema.nullable(),
        })
        .strict(),
    ),
    cleanup: z.record(z.enum(['deleted', 'failed'])),
    error: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    limits: z
      .object({
        timeoutMs: z.number().positive(),
        requestTimeoutMs: z.number().positive(),
        maxConcurrentSubagents: z.literal(2),
      })
      .strict(),
    unverified: z.array(z.string()),
  })
  .strict();
export type ProbeReport = z.infer<typeof reportSchema>;

// Fixed, owned, unpaid routes. Stage 1 never reads 402flow credential variables.
export const probeDefaults = {
  apiHealthUrl: 'https://api-staging.402flow.ai/api/health',
  merchantUrl:
    'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia',
  blockedUrl: 'https://example.com/',
};

export function validateConfig(config: ProbeConfig): ProbeConfig {
  configSchema.parse(config);
  for (const value of [
    config.canaryUrl,
    config.apiHealthUrl,
    config.merchantUrl,
    config.blockedUrl,
  ]) {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '8443') ||
      url.hostname.endsWith('.') ||
      isIP(url.hostname) ||
      url.hostname.startsWith('[') ||
      url.hostname === 'localhost' ||
      /\.(localhost|local|internal)$/.test(url.hostname) ||
      !url.hostname.includes('.')
    ) {
      throw new ProbeError(
        'expected_public_https_url_without_credentials_or_query',
      );
    }
  }
  if (
    Object.entries(probeDefaults).some(
      ([key, value]) => config[key as keyof typeof probeDefaults] !== value,
    )
  ) {
    throw new ProbeError('expected_fixed_unpaid_probe_routes');
  }
  if (new URL(config.canaryUrl).pathname !== '/probe')
    throw new ProbeError('expected_canary_probe_route');
  const allowed = [
    config.canaryUrl,
    config.apiHealthUrl,
    config.merchantUrl,
  ].map((url) => new URL(url).hostname);
  if (
    new Set(allowed).size !== 3 ||
    allowed.includes(new URL(config.blockedUrl).hostname) ||
    new URL(config.canaryUrl).hostname === 'api.openai.com'
  )
    throw new ProbeError('canary_host_must_be_separate');
  return config;
}

export class OpenAiProbeApi {
  constructor(
    private readonly apiKey: string,
    private readonly secrets: string[] = [],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const response = await requestText(
      this.fetchImpl,
      `https://api.openai.com/v1${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'agents=v1',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      30_000,
      1_048_576,
      this.signal,
    );
    // Never log provider bodies or errors. Scan all fetched records, even items
    // excluded from the evidence report, before parsing or persisting anything.
    if (
      [this.apiKey, ...this.secrets].some(
        (secret) => secret && response.text.includes(secret),
      )
    ) {
      throw new ProbeError('secret_exposed_by_provider');
    }
    if (!response.ok)
      throw new ProbeError(`openai_http_${response.status}`, response.status);
    if (!response.text) return {};
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw new ProbeError('invalid_provider_json');
    }
  }

  async list(path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        limit: '100',
        order: 'asc',
        ...(after ? { after } : {}),
      });
      const value = pageSchema.parse(await this.request(`${path}?${query}`));
      all.push(...value.data);
      if (!value.has_more) return all;
      if (!value.last_id || cursors.has(value.last_id) || !value.data.length)
        throw new ProbeError('invalid_pagination');
      after = value.last_id;
      cursors.add(after);
    }
    throw new ProbeError('pagination_limit');
  }
}

export async function checkAccess(api: OpenAiProbeApi, model?: string) {
  const result: Record<string, string> = {};
  const paths = ['/agents?limit=1', '/vaults?limit=1'];
  if (model) {
    configSchema.shape.model.parse(model);
    paths.push(`/models/${encodeURIComponent(model)}`);
  }
  for (const path of paths) {
    try {
      const value = await api.request(path);
      if (path.startsWith('/models/')) {
        if (z.object({ id: z.string() }).parse(value).id !== model)
          throw new ProbeError('model_mismatch');
      } else pageSchema.parse(value);
      result[path] = 'accessible';
    } catch (error) {
      result[path] =
        error instanceof ProbeError ? error.code : 'unexpected_response_schema';
    }
  }
  return result;
}

export async function writeReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function buildSession(
  config: ProbeConfig,
  vaultId: string,
  canaryHash: string,
) {
  const artifact = await hostedSdk();
  const code = await readFile(
    new URL('./sandbox-probe.js', import.meta.url),
    'utf8',
  );
  const transport = await readFile(
    new URL('./transport.js', import.meta.url),
    'utf8',
  );
  return {
    metadata: {
      reference_probe_run_id: config.runId,
      sdk_artifact_sha256: artifact.sha256,
    },
    agent: {
      model: config.model,
      instructions:
        'Run only the supplied capability probe. Do not modify files, inspect environment variables, retry commands, install packages, or make other network calls. Report failures without trying to fix them.',
      multi_agent: { enabled: true, max_concurrent_subagents: 2 },
    },
    environment: {
      type: 'openai_hosted',
      network: {
        access: 'restricted',
        allowed_domains: [
          ...new Set(
            [config.canaryUrl, config.apiHealthUrl, config.merchantUrl].map(
              (url) => new URL(url).hostname,
            ),
          ),
        ],
      },
      packages: artifact.packages,
      setup_commands: artifact.setup_commands,
      files: [
        artifact.file,
        {
          type: 'inline',
          path: '/workspace/probe.mjs',
          data: Buffer.from(
            code.replace(/(['"])\.\/transport\.js\1/g, "'./transport.mjs'"),
          ).toString('base64'),
        },
        {
          type: 'inline',
          path: '/workspace/transport.mjs',
          data: Buffer.from(transport).toString('base64'),
        },
        {
          type: 'inline',
          path: '/workspace/probe-config.json',
          data: Buffer.from(JSON.stringify({ ...config, canaryHash })).toString(
            'base64',
          ),
        },
      ],
    },
    vault_ids: [vaultId],
    input:
      'First run exactly: `node /workspace/probe.mjs root`. Then delegate to two separate subagents: one must run exactly `node /workspace/probe.mjs child-a` and the other exactly `node /workspace/probe.mjs child-b`. Each command runs once. Wait for both children, then finish with a brief status. Do not print or copy credentials. Do not create any additional subagents.',
  };
}

export async function collectEvidence(
  api: OpenAiProbeApi,
  sessionId: string,
  runId: string,
) {
  const path = `/agents/sessions/${sessionId}`;
  const subagents = (await api.list(`${path}/subagents`)).map((value) =>
    z
      .object({ id: idSchema, session_id: idSchema, parent_agent_id: idSchema })
      .parse(value),
  );
  if (
    subagents.length !== 2 ||
    new Set(subagents.map((entry) => entry.id)).size !== 2
  )
    throw new ProbeError('expected_two_subagents');
  if (
    subagents.some(
      (entry) =>
        entry.session_id !== sessionId ||
        subagents.some((child) => child.id === entry.parent_agent_id),
    ) ||
    new Set(subagents.map((entry) => entry.parent_agent_id)).size !== 1
  )
    throw new ProbeError('attribution_mismatch');
  const evidence: ProbeReport['evidence'] = [];
  let rootAgentId: string | undefined;
  for (const subagentId of [null, ...subagents.map((entry) => entry.id)]) {
    const itemsPath = subagentId
      ? `${path}/subagents/${subagentId}/items`
      : `${path}/items`;
    for (const item of await api.list(itemsPath)) {
      const identity = z.object({ type: z.string() }).parse(item);
      if (identity.type !== 'command_execution') continue;
      const command = commandSchema.safeParse(item);
      if (!command.success) throw new ProbeError('invalid_probe_command');
      const actor = actors.find((candidate) => {
        const expected = `node /workspace/probe.mjs ${candidate}`;
        // Hosted command records include the executor's shell wrapper.
        // Accept only these literal forms, never parse arbitrary shell text.
        return [expected, `/bin/bash -lc '${expected}'`].includes(
          command.data.command.trim(),
        );
      });
      if (!actor) throw new ProbeError('unexpected_probe_command');
      const result = resultSchema.parse(JSON.parse(command.data.output));
      const turnPath = subagentId
        ? `${path}/subagents/${subagentId}/turns`
        : `${path}/turns`;
      const turn = turnSchema.parse(
        await api.request(`${turnPath}/${command.data.turn_id}`),
      );
      if (
        result.runId !== runId ||
        result.actor !== actor ||
        turn.id !== command.data.turn_id ||
        turn.session_id !== sessionId ||
        turn.subagent_id !== subagentId ||
        turn.status !== 'completed' ||
        (actor === 'root') !== (subagentId === null)
      ) {
        throw new ProbeError('attribution_mismatch');
      }
      if (subagentId === null) rootAgentId = turn.agent_id;
      evidence.push({
        result,
        commandId: command.data.id,
        turnId: turn.id,
        subagentId,
      });
    }
  }
  if (subagents.some((entry) => entry.parent_agent_id !== rootAgentId))
    throw new ProbeError('attribution_mismatch');
  if (
    new Set(evidence.map((entry) => entry.commandId)).size !== 3 ||
    actors.some(
      (actor) =>
        evidence.filter((entry) => entry.result.actor === actor).length !== 1,
    ) ||
    new Set(
      evidence
        .filter((entry) => entry.subagentId)
        .map((entry) => entry.subagentId),
    ).size !== 2
  ) {
    throw new ProbeError('missing_or_duplicate_probe_commands');
  }
  return evidence;
}

export async function cleanupResources(
  api: OpenAiProbeApi,
  resources: Resources,
  wait = delay,
) {
  const result: ProbeReport['cleanup'] = {};
  if (resources.sessionId) {
    await api
      .request(`/agents/sessions/${resources.sessionId}/events`, 'POST', {
        events: [{ type: 'agent.session.input.cancel' }],
      })
      .catch(() => undefined);
  }
  const paths = [
    ...(resources.vaultId && resources.credentialId
      ? [`/vaults/${resources.vaultId}/credentials/${resources.credentialId}`]
      : []),
    ...(resources.sessionId ? [`/agents/sessions/${resources.sessionId}`] : []),
    ...(resources.vaultId ? [`/vaults/${resources.vaultId}`] : []),
  ];
  for (const path of paths) {
    result[path] = 'failed';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.request(path, 'DELETE');
        result[path] = 'deleted';
        break;
      } catch (error) {
        if (error instanceof ProbeError && error.status === 404) {
          result[path] = 'deleted';
          break;
        }
        if (
          !(error instanceof ProbeError) ||
          error.status !== 409 ||
          attempt === 2
        )
          break;
        await wait(2_000);
      }
    }
  }
  return result;
}

export async function runProbe(
  config: ProbeConfig,
  apiKey: string,
  reportPath: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: typeof delay;
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionBuilder?: (
      config: ProbeConfig,
      vaultId: string,
      canaryHash: string,
    ) => Promise<unknown>;
  } = {},
): Promise<ProbeReport> {
  validateConfig(config);
  const canary = `402flow-probe-${randomBytes(32).toString('hex')}`;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const api = new OpenAiProbeApi(
    apiKey,
    [canary],
    options.fetchImpl,
    controller.signal,
  );
  // Cleanup must remain possible after the run deadline or Ctrl-C.
  const cleanupApi = new OpenAiProbeApi(apiKey, [canary], options.fetchImpl);
  const wait = options.wait ?? delay;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const report: ProbeReport = {
    schemaVersion: 1,
    versions: { sdk: '0.1.3', openAiBeta: 'agents=v1' },
    config,
    startedAt: new Date().toISOString(),
    state: 'running',
    resources: {},
    evidence: [],
    cleanup: {},
    limits: { timeoutMs, requestTimeoutMs: 30_000, maxConcurrentSubagents: 2 },
    unverified: [
      'provider_retention_and_storage',
      'arbitrary_secret_exfiltration',
      'redirect_and_wrong_host_substitution',
      'paid_execution',
      'runtime_renewal',
      'cryptographic_child_identity',
      'egress_rejection_cause',
      'model_and_container_cost',
      'encoded_secret_exfiltration',
      'unfetched_provider_surfaces',
    ],
  };
  // Reserve a new report: never destroy an earlier run's recovery IDs.
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const reservation = await open(reportPath, 'wx', 0o600);
  await reservation.close();
  await writeReport(reportPath, report);
  options.signal?.addEventListener('abort', interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  const timer = setTimeout(interrupt, timeoutMs);
  const create = async (
    kind: NonNullable<Resources['pendingCreation']>,
    path: string,
    body: unknown,
  ) => {
    report.resources.pendingCreation = kind;
    await writeReport(reportPath, report);
    const created = createdSchema.parse(await api.request(path, 'POST', body));
    report.resources[`${kind}Id`] = created.id;
    delete report.resources.pendingCreation;
    await writeReport(reportPath, report);
    return created.id;
  };
  try {
    const access = await checkAccess(api, config.model);
    if (Object.values(access).some((value) => value !== 'accessible'))
      throw new ProbeError('agents_or_vaults_unavailable');
    // A reachable external baseline prevents a pre-existing DNS/network outage
    // from being reported as proof of restricted sandbox egress.
    const baseline = await requestText(
      options.fetchImpl ?? fetch,
      config.blockedUrl,
      {},
      15_000,
      16_384,
      controller.signal,
    );
    if (!baseline.ok) throw new ProbeError('blocked_host_baseline_failed');
    const receiver = await requestText(
      options.fetchImpl ?? fetch,
      config.canaryUrl,
      {},
      15_000,
      4096,
      controller.signal,
    );
    const receiverBody = z
      .object({ authorizationSha256: z.string() })
      .strict()
      .parse(JSON.parse(receiver.text));
    if (
      !receiver.ok ||
      receiverBody.authorizationSha256 !==
        createHash('sha256').update('').digest('hex')
    ) {
      throw new ProbeError('canary_receiver_unavailable');
    }
    controller.signal.throwIfAborted();
    const vaultId = await create('vault', '/vaults', {
      name: `402flow-probe-${config.runId}`,
      metadata: { reference_probe_run_id: config.runId },
    });
    const credentialId = await create(
      'credential',
      `/vaults/${vaultId}/credentials`,
      {
        name: `402flow-probe-${config.runId}`,
        auth: {
          type: 'environment_variable',
          secret_name: 'X402FLOW_PROBE_CANARY',
          secret_value: canary,
          networking: {
            type: 'limited',
            allowed_hosts: [new URL(config.canaryUrl).hostname],
          },
        },
      },
    );
    await api.request(`/vaults/${vaultId}`);
    await api.request(`/vaults/${vaultId}/credentials/${credentialId}`);
    const sessionId = await create(
      'session',
      '/agents/sessions',
      await (options.sessionBuilder ?? buildSession)(
        config,
        vaultId,
        hashAuthorization(canary),
      ),
    );
    for (;;) {
      controller.signal.throwIfAborted();
      const session = z
        .object({
          id: idSchema,
          status: z.string(),
          environment: z.object({
            id: idSchema,
            type: z.literal('openai_hosted'),
          }),
        })
        .parse(await api.request(`/agents/sessions/${sessionId}`));
      if (session.id !== sessionId) throw new ProbeError('session_mismatch');
      if (session.status === 'failed') throw new ProbeError('session_failed');
      const environment = z
        .object({ id: idSchema, status: z.string() })
        .parse(
          await api.request(`/agents/environments/${session.environment.id}`),
        );
      if (environment.id !== session.environment.id)
        throw new ProbeError('environment_mismatch');
      if (environment.status === 'failed')
        throw new ProbeError('environment_failed');
      const turns = (await api.list(`/agents/sessions/${sessionId}/turns`)).map(
        (value) => turnSchema.parse(value),
      );
      if (turns.some((turn) => turn.session_id !== sessionId))
        throw new ProbeError('attribution_mismatch');
      const roots = turns.filter((turn) => turn.subagent_id === null);
      if (roots.length > 1) throw new ProbeError('unexpected_root_turns');
      const root = roots[0];
      if (root?.status === 'failed' || root?.status === 'cancelled')
        throw new ProbeError('root_turn_failed');
      if (root?.status === 'completed' && environment.status === 'connected')
        break;
      await wait(2_000, undefined, { signal: controller.signal });
    }
    report.evidence = await collectEvidence(api, sessionId, config.runId);
    if (
      report.evidence.some((entry) =>
        Object.values(entry.result.checks).some((value) => !value),
      )
    )
      throw new ProbeError('capability_check_failed');
    report.state = 'passed';
  } catch (error) {
    report.state = 'failed';
    report.error = options.signal?.aborted
      ? 'interrupted'
      : controller.signal.aborted
        ? 'probe_timeout'
        : error instanceof ProbeError
          ? error.code
          : 'probe_failed';
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', interrupt);
    report.cleanup = await cleanupResources(cleanupApi, report.resources, wait);
    if (
      report.resources.pendingCreation ||
      Object.values(report.cleanup).includes('failed')
    ) {
      report.state = 'failed';
      report.error ??= 'cleanup_incomplete';
    }
    await writeReport(reportPath, report);
  }
  return report;
}

// Recovery is cleanup-only in Stage 1. Never recreate a missing or ambiguous
// session, clear pendingCreation, or rerun a hosted operation from a saved report.
export async function cleanupReport(
  path: string,
  api: OpenAiProbeApi,
): Promise<ProbeReport> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1_048_576) throw new ProbeError('report_too_large');
  const report = reportSchema.parse(JSON.parse(bytes.toString('utf8')));
  validateConfig(report.config);
  report.cleanup = await cleanupResources(api, report.resources);
  if (
    report.state === 'running' ||
    report.resources.pendingCreation ||
    Object.values(report.cleanup).includes('failed')
  ) {
    report.state = 'failed';
    report.error ??= 'interrupted_or_cleanup_incomplete';
  }
  await writeReport(path, report);
  return report;
}

// A surviving lock after a crash requires operator inspection before removal.
export async function withReportLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  try {
    return await action();
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}
