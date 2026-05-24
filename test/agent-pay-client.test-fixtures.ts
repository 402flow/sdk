export const baseContext = {
  organization: 'acme-labs',
  agent: 'synthetic-demo-agent',
};

export const baseChallenge = {
  protocol: 'x402' as const,
  headers: {} as Record<string, string>,
};

export const baseMoney = {
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '1.000000',
  amountMinor: '1000000',
  precision: 6,
  unit: 'minor' as const,
};

export const unsupportedSdkVersionMessage =
  'Mocked unsupported SDK version error from the control plane.';

export const baseReceipt = {
  receiptId: '00000000-0000-0000-0000-000000000030',
  paidRequestId: '00000000-0000-0000-0000-000000000130',
  paymentAttemptId: '00000000-0000-0000-0000-000000000230',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  merchantId: '00000000-0000-0000-0000-000000000003',
  protocol: 'x402' as const,
  money: baseMoney,
  authorizationOutcome: 'allowed' as const,
  status: 'confirmed' as const,
  reconciliationStatus: 'none' as const,
  requestUrl: 'https://merchant.example.com/data',
  requestMethod: 'POST' as const,
  createdAt: '2026-03-10T00:00:00.000Z',
};