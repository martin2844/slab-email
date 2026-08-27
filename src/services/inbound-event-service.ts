import { clearInterval, setInterval } from 'node:timers';

import { AccountService } from './account-service.js';
import {
  DatabaseService,
  InboundScanStateChangedError
} from '../db/database.js';
import { Logger } from '../utils/logger.js';
import type { EmailMessageCompact, InboundPollState } from '../types/models.js';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_POLL = 50;
const POLL_OVERLAP_MS = 5 * 60 * 1000;

export type InboundPollResult = {
  accounts: number;
  discovered: number;
  emitted: number;
  failed: number;
  deferred: number;
};

export class InboundEventService {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<InboundPollResult>;

  constructor(
    private readonly accountService: AccountService,
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly intervalMs: number
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.schedulePoll();
    this.timer = setInterval(() => this.schedulePoll(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  pollNow(): Promise<InboundPollResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runPoll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private schedulePoll(): void {
    void this.pollNow().catch((error) => {
      this.logger.warn('inbound email poll aborted', {
        error: error instanceof Error ? error.message : 'inbound poll failed'
      });
    });
  }

  private nextScanStartedAt(state?: InboundPollState): string {
    const floor = Math.max(
      Date.parse(state?.updatedAt ?? '') || 0,
      Date.parse(state?.lastSuccessfulPollAt ?? '') || 0
    );
    return new Date(Math.max(Date.now(), floor + 1)).toISOString();
  }

  private timestampAtOrAfter(value: string): string {
    return new Date(Math.max(Date.now(), Date.parse(value))).toISOString();
  }

  private async runPoll(): Promise<InboundPollResult> {
    const accounts = this.accountService
      .listAccounts()
      .filter((account) => account.enabled && account.capabilities.read && account.capabilities.search);
    const result: InboundPollResult = {
      accounts: accounts.length,
      discovered: 0,
      emitted: 0,
      failed: 0,
      deferred: 0
    };
    for (const account of accounts) {
      let scanStartedAt: string | undefined;
      let cursor: string | undefined;
      let accountGeneration: number | undefined;
      try {
        const snapshot = await this.accountService.getInboundProviderSnapshot(
          account.id
        );
        const activeAccount = snapshot.account;
        accountGeneration = snapshot.generation;
        if (
          !activeAccount.enabled ||
          !activeAccount.capabilities.read ||
          !activeAccount.capabilities.search
        ) {
          continue;
        }
        const current = this.db.getInboundPollState(account.id);
        scanStartedAt = current?.scanStartedAt ?? this.nextScanStartedAt(current);
        const activeScanStartedAt = scanStartedAt;
        const state = this.db.beginInboundScan(
          account.id,
          accountGeneration,
          activeScanStartedAt
        );
        const provider = snapshot.provider;
        const initialized = Boolean(state?.initializedAt);
        const since = state?.lastSuccessfulPollAt
          ? new Date(new Date(state.lastSuccessfulPollAt).getTime() - POLL_OVERLAP_MS).toISOString()
          : undefined;
        const cursors = new Set<string>();
        cursor = state.scanCursor ?? undefined;
        let identityEpoch = state.identityEpoch ?? undefined;
        if (cursor) cursors.add(cursor);
        let completed = false;
        for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
          const response = await provider.searchMessages({
            accountId: account.id,
            inboundOnly: true,
            since,
            limit: PAGE_SIZE,
            cursor
          });
          if (identityEpoch && !response.identityEpoch) {
            throw new Error('provider identity epoch disappeared');
          }
          if (
            identityEpoch &&
            response.identityEpoch &&
            response.identityEpoch !== identityEpoch
          ) {
            this.db.rebaselineInboundIdentity({
              accountId: account.id,
              scanStartedAt: activeScanStartedAt,
              expectedCursor: cursor,
              expectedIdentityEpoch: identityEpoch,
              identityEpoch: response.identityEpoch,
              restartedAt: this.nextScanStartedAt(
                this.db.getInboundPollState(account.id)
              ),
              accountGeneration
            });
            completed = true;
            result.deferred += 1;
            break;
          }
          const responseIdentityEpoch =
            response.identityEpoch ?? identityEpoch;
          const reachedSeenBoundary =
            initialized &&
            response.items.some((message) =>
              this.db.hasSeenInboundMessageBefore(
                account.id,
                message.id,
                activeScanStartedAt
              )
            );
          const complete = reachedSeenBoundary || !response.nextCursor;
          if (
            !complete &&
            response.nextCursor &&
            cursors.has(response.nextCursor)
          ) {
            throw new Error('provider returned a repeated inbound cursor');
          }
          const messages: EmailMessageCompact[] = [
            ...new Map(
              response.items.map((message) => [message.id, message])
            ).values()
          ].map((message) => ({
            ...message,
            accountId: account.id,
            subject: message.subject.slice(0, 1_000)
          }));
          const discoveredAt = this.timestampAtOrAfter(activeScanStartedAt);
          const recorded = this.db.recordInboundPage({
            account: activeAccount,
            messages,
            emitEvents: initialized,
            discoveredAt,
            scanStartedAt: activeScanStartedAt,
            expectedCursor: cursor,
            nextCursor: complete ? undefined : response.nextCursor,
            complete,
            expectedIdentityEpoch: identityEpoch,
            identityEpoch: responseIdentityEpoch,
            accountGeneration
          });
          result.discovered += recorded.discovered;
          result.emitted += recorded.emitted;
          identityEpoch = responseIdentityEpoch;
          if (complete) {
            completed = true;
            break;
          }
          if (!response.nextCursor) throw new Error('missing inbound cursor');
          cursors.add(response.nextCursor);
          cursor = response.nextCursor;
        }
        if (!completed && cursor) result.deferred += 1;
      } catch (error) {
        if (error instanceof InboundScanStateChangedError) continue;
        if (!this.db.getEmailAccountById(account.id)) continue;
        const message = error instanceof Error ? error.message : 'inbound poll failed';
        try {
          if (!scanStartedAt || accountGeneration === undefined) throw error;
          const marked = this.db.markInboundPollError(
            account.id,
            message,
            scanStartedAt,
            accountGeneration,
            cursor
          );
          if (!marked) continue;
        } catch {
          if (!this.db.getEmailAccountById(account.id)) continue;
        }
        result.failed += 1;
        this.logger.warn('inbound email poll failed', {
          accountId: account.id,
          provider: account.provider,
          error: message
        });
      }
    }
    return result;
  }
}
