export function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) {
    return undefined;
  }

  const normalizedHeaders: Record<string, string> = {};
  const headerMap = new Headers(headers);

  headerMap.forEach((value, key) => {
    normalizedHeaders[key] = value;
  });

  return normalizedHeaders;
}