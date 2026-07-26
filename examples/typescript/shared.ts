import { AgentPayClient } from '@402flow/sdk';

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Set ${name} before running this example.`);
  }

  return value;
}

export function createClient(): AgentPayClient {
  const bootstrapKey = process.env.X402FLOW_BOOTSTRAP_KEY?.trim();
  const runtimeToken = process.env.X402FLOW_RUNTIME_TOKEN?.trim();

  if (!bootstrapKey && !runtimeToken) {
    throw new Error(
      'Set X402FLOW_BOOTSTRAP_KEY or X402FLOW_RUNTIME_TOKEN before running this example.',
    );
  }

  return new AgentPayClient({
    controlPlaneBaseUrl: requiredEnv('X402FLOW_CONTROL_PLANE_BASE_URL'),
    organization: requiredEnv('X402FLOW_ORGANIZATION'),
    agent: requiredEnv('X402FLOW_AGENT'),
    auth: bootstrapKey
      ? { type: 'bootstrapKey', bootstrapKey }
      : { type: 'runtimeToken', runtimeToken: runtimeToken! },
  });
}

export const demoMerchant = {
  baseSepolia:
    'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/base-sepolia',
  solanaDevnet:
    'https://demo-merchant-staging.402flow.ai/demo-merchant/research-brief/solana-devnet',
} as const;
