const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY = 1_000;

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function providerJson<T>(
  url: string,
  init: NonNullable<Parameters<typeof globalThis.fetch>[1]> & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
  const response = await globalThis.fetch(url, {
    ...requestInit,
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
    let message = `provider returned HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as {
        message?: string;
        error?: string | { message?: string };
      };
      message =
        typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error?.message || parsed.message || message;
    } catch {
      // Never expose an arbitrary upstream HTML error body.
    }
    throw new ProviderHttpError(message, response.status);
  }
  if (response.status === 202 || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function parseAddress(value: string | undefined): { name?: string; address: string } {
  const raw = (value || '').trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  return match
    ? { name: match[1].trim().replace(/^"|"$/g, '') || undefined, address: match[2].trim().toLowerCase() }
    : { address: raw.toLowerCase() };
}

export function formatAddress(value: { name?: string; address: string }): string {
  return value.name ? `${value.name} <${value.address}>` : value.address;
}

/**
 * Downloads a binary body. When `maxBytes` is set, the download is aborted as
 * soon as the declared or received size exceeds it.
 */
export async function providerBinary(
  url: string,
  init: NonNullable<Parameters<typeof globalThis.fetch>[1]> & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ data: Buffer; contentType?: string }> {
  const { timeoutMs = 60_000, maxBytes, ...requestInit } = init;
  const response = await globalThis.fetch(url, {
    ...requestInit,
    redirect: requestInit.redirect ?? 'error',
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new ProviderHttpError(`provider returned HTTP ${response.status}`, response.status);
  }
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(`download exceeds ${maxBytes} bytes`, 413);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (maxBytes !== undefined && data.length > maxBytes) {
    throw new ProviderHttpError(`download exceeds ${maxBytes} bytes`, 413);
  }
  return { data, contentType: response.headers.get('content-type') ?? undefined };
}

/** Fetches a provider-issued, pre-signed download URL (no credentials are sent). */
export async function downloadSignedUrl(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('attachment download URL must use https');
  return (await providerBinary(parsed.toString(), { redirect: 'follow' })).data;
}
