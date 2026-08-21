import {
  DraftInput,
  EmailMessage,
  EmailMessageCompact,
  MessageSearchParams,
  ProviderSendResult,
  ReplyInput,
  SendInput,
  ConnectionStatus,
  AccountCapabilities,
  ProviderType
} from '../types/models.js';

export interface ProviderConnectionConfig {
  emailAddress: string;
  displayName: string;
  provider: ProviderType;
}

export interface Provider {
  getProviderType(): ProviderType;
  getCapabilities(): AccountCapabilities;
  verifyConnection(): Promise<ConnectionStatus>;
  searchMessages(params: MessageSearchParams): Promise<{
    items: EmailMessageCompact[];
    nextCursor?: string;
    total?: number;
  }>;
  getMessage(accountId: string, messageId: string): Promise<EmailMessage>;
  getThread(accountId: string, threadId: string): Promise<EmailMessage[]>;
  createDraft(input: DraftInput): Promise<{ draftId: string; threadId?: string | null }>;
  sendMessage(input: SendInput): Promise<ProviderSendResult>;
  replyToMessage(input: ReplyInput): Promise<ProviderSendResult>;
}
