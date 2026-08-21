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
