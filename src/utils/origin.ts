const normalizeHost = (value: string): string => value.trim().toLowerCase();

export const buildOriginMatcher = (allowed: string[]): Set<string> => {
  const set = new Set<string>();
  for (const item of allowed ?? []) {
    const normalized = normalizeHost(item);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }

  if (!set.size) {
    set.add('127.0.0.1:6981');
    set.add('localhost:6981');
  }

  return set;
};

export const isOriginAllowed = (headerValue: string | undefined, allowed: Set<string>): boolean => {
  if (!headerValue) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(headerValue);
  } catch {
    return false;
  }

  const host = normalizeHost(url.host);
  const hostname = normalizeHost(url.hostname);

  return allowed.has(host) || allowed.has(hostname) || allowed.has(`${hostname}:${url.port}`);
};
