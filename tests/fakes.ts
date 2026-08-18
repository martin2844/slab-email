import { vi } from 'vitest';

import { DraftInput, EmailMessage, EmailMessageCompact, MessageSearchParams, Provider, ProviderSendResult, ReplyInput, SendInput, ConnectionStatus } from '../src/types/models.js';

export interface FakeProviderOverrides {
  searchResult?: EmailMessageCompact[];
  getMessageResult?: EmailMessage;
  getThreadResult?: EmailMessage[];
  sendResult?: ProviderSendResult;
  replyResult?: ProviderSendResult;
  draftResult?: { draftId: string; threadId?: string | null };
  verifyResult?: ConnectionStatus;
}

export const createFakeProvider = (overrides: FakeProviderOverrides = {}): Provider => {
  return {
    getProviderType: () => 'imap_smtp',
    getCapabilities: () => ({ read: true, search: true, draft: true, send: true, reply: true, threads: true }),
    verifyConnection: vi.fn(async (): Promise<ConnectionStatus> => {
      return overrides.verifyResult ?? { status: 'ok', latencyMs: 3, providerMessage: 'ok' };
    }),
    searchMessages: vi.fn(async (_input: MessageSearchParams) => ({
      items: overrides.searchResult ?? [],
      nextCursor: undefined,
      total: overrides.searchResult?.length
    })),
    getMessage: vi.fn(async (_accountId: string, _messageId: string) =>
      overrides.getMessageResult ?? {
        id: _messageId,
        accountId: _accountId,
        provider: 'imap_smtp',
        threadId: 'thread-1',
        from: { address: 'from@example.com' },
        to: [{ address: 'to@example.com' }],
        cc: [],
        bcc: [],
        subject: 'hello',
        date: new Date().toISOString(),
        text: 'body',
        snippet: 'body',
        unread: true
      }),
    getThread: vi.fn(async (_accountId: string, _threadId: string) => overrides.getThreadResult ?? []),
    createDraft: vi.fn(async (_input: DraftInput) => {
      return overrides.draftResult ?? { draftId: 'draft-1', threadId: 'thread-1' };
    }),
    sendMessage: vi.fn(async (_input: SendInput) => {
      return overrides.sendResult ?? { status: 'sent', providerMessageId: 'msg-1' };
    }),
    replyToMessage: vi.fn(async (_input: ReplyInput) => {
      return overrides.replyResult ?? { status: 'sent', providerMessageId: 'reply-1', providerThreadId: 'thread-1' };
    })
  };
};
