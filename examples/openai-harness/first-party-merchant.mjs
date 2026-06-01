export const defaultFirstPartyMerchantBaseUrl = 'https://demo-merchant-staging.402flow.ai';

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function resolveConfiguredFirstPartyMerchantBaseUrl() {
  const configuredBaseUrlRaw =
    process.env.X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL ??
    defaultFirstPartyMerchantBaseUrl;
  const configuredBaseUrl = stripTrailingSlash(configuredBaseUrlRaw.trim());

  let parsedBaseUrl;

  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch (error) {
    throw new Error(
      `X402FLOW_FIRST_PARTY_MERCHANT_BASE_URL must be a valid absolute URL. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }

  return parsedBaseUrl.origin;
}

export function buildFirstPartyMerchantUrl(routePath) {
  if (!routePath.startsWith('/')) {
    throw new Error('First-party merchant routePath must start with /.');
  }

  return `${resolveConfiguredFirstPartyMerchantBaseUrl()}${routePath}`;
}