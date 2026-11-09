import { DatabaseService } from '../db/database.js';
import { ApiError, ERROR_CODES } from '../types/errors.js';
import type { SuppressionEntry, SuppressionKind } from '../types/models.js';

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const ADDRESS_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

export interface SuppressionMatch {
  address: string;
  kind: SuppressionKind;
  value: string;
}

export const normalizeSuppressionAddress = (value: string): string => value.trim().toLowerCase();

export const normalizeSuppressionDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');

/** example.com plus every parent domain with at least two labels (a.b.example.com -> b.example.com, example.com). */
const candidateDomains = (domain: string): string[] => {
  const labels = domain.split('.').filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index < labels.length - 1; index += 1) out.push(labels.slice(index).join('.'));
  return out;
};

export class SuppressionService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Normalizes a suppression target. `address` scope stores the exact mailbox;
   * `domain` scope stores the domain (taken from an address or given directly)
   * and also matches its subdomains.
   */
  normalizeTarget(input: { kind: SuppressionKind; value: string }): { kind: SuppressionKind; value: string } {
    if (input.kind === 'address') {
      const value = normalizeSuppressionAddress(input.value);
      if (!ADDRESS_PATTERN.test(value) || !DOMAIN_PATTERN.test(value.split('@')[1] ?? '')) {
        throw new ApiError(ERROR_CODES.INVALID_INPUT, 'a valid email address is required', 400);
      }
      return { kind: 'address', value };
    }
    const raw = input.value.includes('@') ? input.value.split('@').pop() ?? '' : input.value;
    const value = normalizeSuppressionDomain(raw);
    if (!DOMAIN_PATTERN.test(value)) {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, 'a valid domain is required', 400);
    }
    return { kind: 'domain', value };
  }

  add(input: {
    kind: SuppressionKind;
    value: string;
    reason: string;
    source: string;
    accountId?: string | null;
    profileId?: string | null;
  }): { entry: SuppressionEntry; created: boolean } {
    const target = this.normalizeTarget(input);
    const reason = input.reason.trim();
    if (!reason) throw new ApiError(ERROR_CODES.INVALID_INPUT, 'reason is required', 400);
    return this.db.addSuppression({ ...input, ...target, reason: reason.slice(0, 1000) });
  }

  list(filter: { query?: string } = {}): SuppressionEntry[] {
    return this.db.listSuppressions(filter);
  }

  remove(id: number): void {
    if (!this.db.removeSuppression(id)) {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, 'suppression entry not found', 404);
    }
  }

  /** Returns one match per suppressed recipient address. */
  findMatches(addresses: string[]): SuppressionMatch[] {
    const normalized = [...new Set(addresses.map(normalizeSuppressionAddress).filter(Boolean))];
    if (!normalized.length) return [];
    const domainsByAddress = new Map(
      normalized.map((address) => [address, candidateDomains(address.split('@').pop() ?? '')])
    );
    const entries = this.db.findSuppressions(normalized, [...new Set([...domainsByAddress.values()].flat())]);
    const matches: SuppressionMatch[] = [];
    for (const address of normalized) {
      const exact = entries.find((entry) => entry.kind === 'address' && entry.value === address);
      const domain = entries.find(
        (entry) => entry.kind === 'domain' && domainsByAddress.get(address)!.includes(entry.value)
      );
      const hit = exact ?? domain;
      if (hit) matches.push({ address, kind: hit.kind, value: hit.value });
    }
    return matches;
  }

  /** Throws RECIPIENT_SUPPRESSED when any address is on the list. */
  assertNotSuppressed(addresses: string[], context: string): void {
    const matches = this.findMatches(addresses);
    if (!matches.length) return;
    throw new ApiError(
      ERROR_CODES.RECIPIENT_SUPPRESSED,
      `${context} refused: ${matches.map((match) => match.address).join(', ')} opted out (suppression list). Nothing was sent; remove these recipients to continue.`,
      409,
      { suppressed: matches }
    );
  }
}
