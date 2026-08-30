import { randomUUID } from 'node:crypto';
import { AccountService } from './account-service.js';
import { DatabaseService } from '../db/database.js';
import { RuntimeConfig } from '../config/env.js';
import { ApiError, ERROR_CODES } from '../types/errors.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import {
  DraftInput,
  MessageSearchParams,
  ReplyInput,
  SendInput,
  EmailMessageCompact,
  EmailMessage
} from '../types/models.js';
import type { Provider } from '../providers/types.js';

const PROVIDER_RATE_WINDOW_MS = 60 * 60 * 1000;

type SendOperationResult = {
  status: 'sent' | 'failed' | 'unknown';
  providerMessageId?: string;
  providerThreadId?: string | null;
  detail?: string;
};

export class MailService {
  constructor(
    private readonly accountService: AccountService,
    private readonly db: DatabaseService,
    private readonly config: RuntimeConfig
  ) {}

  private getProfile(req: AuthenticatedRequest) {
    if (!req.authContext || req.authContext.type !== 'profile' || !req.authContext.profile) {
      throw new ApiError(ERROR_CODES.AUTH_REQUIRED, 'connector token required', 401);
    }
    return req.authContext.profile;
  }

  private canRead(req: AuthenticatedRequest): void {
    const profile = this.getProfile(req);
    if (!profile.readEnabled) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, 'read permission denied', 403);
    }
  }

  private canDraft(req: AuthenticatedRequest): void {
    const profile = this.getProfile(req);
    if (!profile.draftEnabled) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, 'draft permission denied', 403);
    }
  }

  private canSend(req: AuthenticatedRequest): void {
    const profile = this.getProfile(req);
    if (!profile.sendEnabled) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, 'send permission denied', 403);
    }
  }

  private resolveAccountAccess(req: AuthenticatedRequest, accountId: string) {
    const profile = this.getProfile(req);
    if (!profile.accountIds.includes(accountId)) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, 'account not in access profile', 403);
    }

    const account = this.accountService.getAccount(accountId);
    if (!account.enabled) {
      throw new ApiError(ERROR_CODES.ACCOUNT_DISABLED, 'account disabled', 409);
    }
    return account;
  }

  private assertExpectedSender(
    account: { emailAddress: string },
    expectedFrom: string | undefined
  ): void {
    if (!expectedFrom) return;
    const actualFrom = account.emailAddress.trim().toLowerCase();
    if (expectedFrom.trim().toLowerCase() === actualFrom) return;
    throw new ApiError(
      ERROR_CODES.SENDER_IDENTITY_MISMATCH,
      'The requested sender does not match the connected account identity.',
      409,
      { expectedFrom, actualFrom }
    );
  }

  listAccounts(req: AuthenticatedRequest) {
    const profile = this.getProfile(req);
    const all = this.accountService.listAccounts();
    return all.filter((account) => profile.accountIds.includes(account.id));
  }

  async search(req: AuthenticatedRequest, input: MessageSearchParams): Promise<{ items: EmailMessageCompact[]; nextCursor?: string }> {
    this.canRead(req);
    const account = this.resolveAccountAccess(req, input.accountId);

    const provider = await this.accountService.getProviderForAccount(account.id);
    const searchCaps = provider.getCapabilities();
    if (!searchCaps.read || !searchCaps.search) {
      throw new ApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'search unavailable for account provider', 405);
    }

    const result = await provider.searchMessages(input);
    return {
      items: result.items.map((item) => ({
        id: item.id,
        accountId: account.id,
        threadId: item.threadId,
        from: item.from,
        to: item.to,
        subject: item.subject,
        date: item.date,
        snippet: item.snippet,
        unread: item.unread
      })),
      nextCursor: result.nextCursor
    };
  }

  async getMessage(req: AuthenticatedRequest, accountId: string, messageId: string): Promise<EmailMessage> {
    this.canRead(req);
    const account = this.resolveAccountAccess(req, accountId);

    const provider = await this.accountService.getProviderForAccount(account.id);
    const caps = provider.getCapabilities();
    if (!caps.read) {
      throw new ApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'message read unavailable', 405);
    }

    return provider.getMessage(account.id, messageId);
  }

  async getThread(req: AuthenticatedRequest, accountId: string, threadId: string): Promise<EmailMessage[]> {
    this.canRead(req);
    const account = this.resolveAccountAccess(req, accountId);

    const provider = await this.accountService.getProviderForAccount(account.id);
    if (!provider.getCapabilities().threads) {
      throw new ApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'thread listing unavailable for provider', 405);
    }

    return provider.getThread(account.id, threadId);
  }

  async createDraft(req: AuthenticatedRequest, input: DraftInput): Promise<{ draftId: string; threadId?: string | null }> {
    this.canRead(req);
    this.canDraft(req);

    const account = this.resolveAccountAccess(req, input.accountId);
    const provider = await this.accountService.getProviderForAccount(account.id);

    if (!provider.getCapabilities().draft) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, 'draft unsupported for provider', 405);
    }

    return provider.createDraft(input);
  }

  private async runIdempotentOperation(
    req: AuthenticatedRequest,
    accountId: string,
    operation: 'send' | 'reply',
    input: {
      idempotencyKey: string;
      preflight?: (provider: Provider) => Promise<void>;
      action: (provider: Provider) => Promise<{
        status: 'sent' | 'failed' | 'unknown';
        providerMessageId?: string;
        providerThreadId?: string | null;
        detail?: string;
      }>;
    }
  ): Promise<SendOperationResult> {
    this.canSend(req);
    const account = this.resolveAccountAccess(req, accountId);

    const currentWindowStart = Date.now() - PROVIDER_RATE_WINDOW_MS;
    const existing = this.db.getSendOperation(account.id, input.idempotencyKey);
    let pendingId: number | undefined;
    let failedOperationId: number | undefined;
    if (existing) {
      if (existing.status === 'sent') {
        return {
          status: existing.status,
          providerMessageId: existing.providerMessageId,
          providerThreadId: existing.providerThreadId
        };
      }
      if (existing.status === 'unknown') {
        throw new ApiError(
          ERROR_CODES.SEND_OUTCOME_UNKNOWN,
          'message was sent but final outcome unknown',
          424,
          {
            status: 'unknown',
            providerMessageId: existing.providerMessageId
          }
        );
      }
      if (existing.status === 'failed') {
        failedOperationId = existing.id;
      } else {
        throw new ApiError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          existing.status === 'pending'
            ? 'operation outcome is unresolved; refusing a blind retry'
            : 'operation already in progress',
          409
        );
      }
    }

    const provider = await this.accountService.getProviderForAccount(account.id);
    const capability = operation === 'send' ? provider.getCapabilities().send : provider.getCapabilities().reply;
    if (!capability) {
      throw new ApiError(ERROR_CODES.PERMISSION_DENIED, `${operation} not supported by provider`, 405);
    }
    await input.preflight?.(provider);

    const recent = this.db.countRecentSendAttempts(account.id, new Date(currentWindowStart).toISOString());
    if (recent >= this.config.maxSendsPerAccountPerHour) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        `send operations exceeded limit of ${this.config.maxSendsPerAccountPerHour} per hour`,
        429
      );
    }

    if (failedOperationId) {
      if (this.db.claimFailedSendOperation(failedOperationId)) {
        pendingId = failedOperationId;
      }
    } else {
      pendingId = this.db.createSendOperation({
        accountId: account.id,
        idempotencyKey: input.idempotencyKey,
        operation
      })?.id;
    }

    if (!pendingId) {
      const afterRace = this.db.getSendOperation(account.id, input.idempotencyKey);
      if (afterRace && afterRace.status === 'sent') {
        return {
          status: afterRace.status,
          providerMessageId: afterRace.providerMessageId,
          providerThreadId: afterRace.providerThreadId
        };
      }
      if (afterRace && afterRace.status === 'unknown') {
        throw new ApiError(
          ERROR_CODES.SEND_OUTCOME_UNKNOWN,
          'message was sent but final outcome unknown',
          424,
          {
            status: 'unknown',
            providerMessageId: afterRace.providerMessageId
          }
        );
      }
      throw new ApiError(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'operation already exists', 409);
    }

    let result: SendOperationResult;

    try {
      result = await input.action(provider);
    } catch (error) {
      this.db.markSendOperationStatus(pendingId, 'unknown', undefined, undefined, String(error));
      throw new ApiError(
        ERROR_CODES.SEND_OUTCOME_UNKNOWN,
        'provider call ended without a confirmed send outcome',
        424,
        { status: 'unknown' }
      );
    }

    const finalStatus = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'unknown';
    this.db.markSendOperationStatus(
      pendingId,
      finalStatus,
      result.providerMessageId,
      result.providerThreadId,
      result.status === 'failed' ? result.detail : undefined
    );

    if (result.status === 'failed') {
      throw new ApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, result.detail || 'send failed', 502);
    }

    if (result.status === 'unknown') {
      throw new ApiError(
        ERROR_CODES.SEND_OUTCOME_UNKNOWN,
        'message was sent but final outcome unknown',
        424,
        {
          status: 'unknown',
          providerMessageId: result.providerMessageId
        }
      );
    }

    return {
      status: finalStatus,
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId ?? null
    };
  }

  async send(req: AuthenticatedRequest, input: SendInput): Promise<SendOperationResult> {
    this.canSend(req);
    const account = this.resolveAccountAccess(req, input.accountId);
    this.assertExpectedSender(account, input.expectedFrom);
    return this.runIdempotentOperation(req, input.accountId, 'send', {
      idempotencyKey: input.idempotencyKey,
      action: (provider) => provider.sendMessage(input)
    });
  }

  async reply(req: AuthenticatedRequest, input: ReplyInput): Promise<SendOperationResult> {
    this.canSend(req);
    const token = input.idempotencyKey || randomUUID();
    const account = this.resolveAccountAccess(req, input.accountId);
    this.assertExpectedSender(account, input.expectedFrom);
    return this.runIdempotentOperation(req, input.accountId, 'reply', {
      idempotencyKey: token,
      preflight: async (provider) => {
        if (!input.expectedSubject) return;
        const original = await provider.getMessage(account.id, input.messageId);
        const originalSender = original.from.address.trim().toLowerCase();
        const requestedRecipients = (input.to ?? []).map(({ address }) =>
          address.trim().toLowerCase()
        );
        const actualSubject = /^re:/i.test(original.subject.trim())
          ? original.subject.trim()
          : `Re: ${original.subject.trim()}`;
        if (
          requestedRecipients.length !== 1 ||
          requestedRecipients[0] !== originalSender ||
          input.replyAll === true ||
          (input.cc?.length ?? 0) > 0 ||
          input.expectedSubject !== actualSubject
        ) {
          throw new ApiError(
            ERROR_CODES.REPLY_PLAN_MISMATCH,
            'The approved reply no longer matches the source message.',
            409,
            {
              requestedTo: requestedRecipients,
              actualTo: [originalSender],
              requestedSubject: input.expectedSubject,
              actualSubject
            }
          );
        }
      },
      action: (provider) => provider.replyToMessage({ ...input, idempotencyKey: token })
    });
  }
}
