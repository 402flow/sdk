import type {
  SdkMerchantResponse,
  SdkPreparedPaidRequestReady,
} from '@402flow/sdk';

export function buildPreparedRequestInit(
  prepared: SdkPreparedPaidRequestReady,
  extraHeaders?: HeadersInit,
): RequestInit {
  const headers = normalizeHeaders(prepared.request.headers);

  if (extraHeaders) {
    const extraHeaderMap = new Headers(extraHeaders);

    extraHeaderMap.forEach((value, key) => {
      headers[key] = value;
    });
  }

  return {
    method: prepared.request.method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(prepared.request.body !== undefined ? { body: prepared.request.body } : {}),
  };
}

export async function toSdkMerchantResponse(
  response: Response,
): Promise<SdkMerchantResponse> {
  return {
    status: response.status,
    headers: normalizeHeaders(response.headers),
    body: await response.text(),
  };
}

export function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) {
    return {};
  }

  const normalizedHeaders: Record<string, string> = {};
  const headerMap = new Headers(headers);

  headerMap.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  return normalizedHeaders;
}