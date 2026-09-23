// Shared with the hosted probe; no third-party dependencies or credential logging.
export class ProbeError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

export async function readBounded(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ProbeError('response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

export async function requestText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; text: string; headers: Headers }> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const timer = setTimeout(interrupt, timeoutMs);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        new ProbeError(signal?.aborted ? 'interrupted' : 'request_timeout'),
      );
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const operation = async () => {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: await readBounded(response, maxBytes, controller.signal),
    };
  };
  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(signal?.aborted ? 'interrupted' : 'transport_failure');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupt);
    if (rejectAbort)
      controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}
