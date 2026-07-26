import { AgentPayClient } from '@402flow/sdk';

import { requiredEnv } from './shared.js';

const timeoutMs = 15_000;
const fetchWithPerCallTimeout: typeof fetch = (input, init = {}) => {
  const signals = [AbortSignal.timeout(timeoutMs)];

  if (init.signal) {
    signals.push(init.signal);
  }

  return fetch(input, {
    ...init,
    signal: AbortSignal.any(signals),
  });
};

export const timeoutClient = new AgentPayClient({
  controlPlaneBaseUrl: requiredEnv('X402FLOW_CONTROL_PLANE_BASE_URL'),
  organization: requiredEnv('X402FLOW_ORGANIZATION'),
  agent: requiredEnv('X402FLOW_AGENT'),
  auth: {
    type: 'runtimeToken',
    runtimeToken: requiredEnv('X402FLOW_RUNTIME_TOKEN'),
  },
  fetch: fetchWithPerCallTimeout,
});
