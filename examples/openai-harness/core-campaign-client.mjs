// Caller limits for the fixed release campaign. Authorization and settlement
// still run through the unmodified SDK and control plane.
const methods = {
  'base-sepolia': ['eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  'base-mainnet': ['eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  'solana-devnet': ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'],
  'solana-mainnet': ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
};

function sameAsset(left, right) {
  return typeof left === 'string' && (right.startsWith('0x')
    ? left.toLowerCase() === right.toLowerCase()
    : left === right);
}

export function createCoreCampaignClient({ client, scenario, campaignId, onAttempt }) {
  const url = new URL(scenario.targetUrl);
  const rail = url.pathname.split('/').at(-1);
  const method = methods[rail];
  if (!method || url.pathname !== `/demo-merchant/research-brief/${rail}`
    || scenario.method !== 'POST' || !campaignId || typeof onAttempt !== 'function') {
    throw new Error('Invalid core campaign scenario configuration.');
  }
  const [network, asset] = method;
  const idempotencyKey = `scenario-core:${campaignId}:${scenario.name}`;
  let attempted = false;

  function assertRequest(request) {
    if (request.url !== scenario.targetUrl || request.method !== 'POST') {
      throw new Error('Core campaign request differs from the authorized scenario.');
    }
  }

  return {
    async preparePaidRequest(url, init = {}) {
      if (attempted) throw new Error('Core campaign execution already attempted; do not retry.');
      assertRequest({ url, method: (init.method ?? 'GET').toUpperCase() });
      return client.preparePaidRequest(url, init);
    },
    async executePreparedRequest(prepared) {
      if (attempted) throw new Error('Core campaign execution already attempted; do not retry.');
      assertRequest(prepared.request);
      const requirement = prepared.paymentRequirement;
      const accepts = prepared.challengeDetails?.accepts;
      const candidate = accepts?.[0];
      if (prepared.kind !== 'ready' || prepared.nextAction !== 'execute'
        || prepared.protocol !== 'x402' || requirement?.protocol !== 'x402'
        || requirement.amountType !== 'exact'
        // These allowlisted USDC contracts use six decimals. The challenge may
        // omit precision; reject a conflicting value when it is provided.
        || (requirement.precision !== undefined && requirement.precision !== 6)
        || ![rail, network].includes(requirement.network)
        || !sameAsset(requirement.asset, asset)
        || !/^[0-9]+$/.test(requirement.amountMinor ?? '')
        || BigInt(requirement.amountMinor) <= 0n || BigInt(requirement.amountMinor) > 1000n
        || accepts?.length !== 1 || candidate.scheme !== 'exact'
        || ![rail, network].includes(candidate.network) || !sameAsset(candidate.asset, asset)
        || (candidate.amount ?? candidate.maxAmountRequired) !== requirement.amountMinor) {
        throw new Error('Core campaign requires one exact USDC offer of at most 0.001 on the expected network.');
      }
      // Consume before recording intent or awaiting the network. A timeout or
      // lost response never permits another payment attempt in this scenario.
      attempted = true;
      await onAttempt({ idempotencyKey, prepared });
      return client.executePreparedRequest(prepared, { idempotencyKey });
    },
  };
}
