export type ProviderType =
  | 'proton_bridge'
  | 'imap_smtp'
  | 'gmail'
  | 'microsoft_graph'
  | 'agentmail'
  | 'resend';

export type ProviderConnectionType = ProviderType;

export type OperationStatus = 'pending' | 'sent' | 'failed' | 'unknown';

export type ThreadingMode = 'best_effort' | 'unsupported';

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AccountCapabilities {
  read: boolean;
  search: boolean;
  draft: boolean;
  send: boolean;
  reply: boolean;
  threads: boolean;
}

export interface EmailMessage {
  id: string;
  accountId: string;
  provider: ProviderType;
  threadId?: string | null;
  messageId?: string;
  inReplyTo?: string | null;
  references?: string[];
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  date: string;
  snippet?: string;
  unread?: boolean;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface EmailMessageCompact {
  id: string;
  accountId: string;
  threadId?: string | null;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  date: string;
  snippet: string;
  unread?: boolean;
}

export interface MessageSearchParams {
  accountId: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  limit?: number;
  cursor?: string;
}

export interface DraftInput {
  accountId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
}

export interface SendInput extends DraftInput {
  expectedFrom?: string;
  idempotencyKey: string;
}

export interface ReplyInput {
  accountId: string;
  expectedFrom?: string;
  expectedSubject?: string;
  messageId: string;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  text: string;
  html?: string;
  replyAll?: boolean;
  idempotencyKey: string;
}

export interface SendResult {
  status: 'sent' | 'failed' | 'unknown';
  providerMessageId?: string;
  providerThreadId?: string | null;
}

export type ProviderSendStatus = 'sent' | 'failed' | 'unknown';

export interface ProviderSendResult {
  status: ProviderSendStatus;
  providerMessageId?: string;
  providerThreadId?: string | null;
  detail?: string;
}

export interface ConnectionStatus {
  status: 'ok' | 'error';
  latencyMs: number;
  providerMessage?: string;
}

export interface AccountConfigCommon {
  emailAddress: string;
  displayName: string;
}

export interface ImapSmtpAccountConfig extends AccountConfigCommon {
  imapHost: string;
  imapPort: number;
  imapTlsMode: 'ssl' | 'starttls' | 'none';
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: 'ssl' | 'starttls' | 'none';
  customCA?: string;
  customTls?: boolean;
  smtpMessageIdDomain?: string;
  managedBridge?: boolean;
  managedBridgeLogin?: string;
}

export interface GmailAccountConfig extends AccountConfigCommon {
  threadingMode?: ThreadingMode;
}

export interface MicrosoftGraphAccountConfig extends AccountConfigCommon {
  tenant: string;
  threadingMode?: ThreadingMode;
}

export interface AgentMailAccountConfig extends AccountConfigCommon {
  inboxId: string;
  baseUrl: string;
}

export interface ResendAccountConfig extends AccountConfigCommon {
  baseUrl: string;
  inboundEnabled: boolean;
}

export interface OAuthMetaState {
  provider: ProviderType;
  returnUrl?: string;
}

export type EmailAccountConfig =
  | ImapSmtpAccountConfig
  | GmailAccountConfig
  | MicrosoftGraphAccountConfig
  | AgentMailAccountConfig
  | ResendAccountConfig;

export interface AccountRecord {
  id: string;
  provider: ProviderType;
  emailAddress: string;
  displayName: string;
  enabled: boolean;
  config: EmailAccountConfig;
  capabilities: AccountCapabilities;
  createdAt: string;
  updatedAt: string;
  lastConnectionStatus?: string | null;
  lastConnectionAt?: string | null;
}

export interface AccessProfile {
  id: string;
  name: string;
  readEnabled: boolean;
  draftEnabled: boolean;
  sendEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccessProfileWithAccounts extends AccessProfile {
  accountIds: string[];
}

export interface OAuthState {
  state: string;
  provider: string;
  requestedAt: number;
  expiresAt: number;
  codeVerifier: string;
  meta: OAuthMetaState | Record<string, unknown>;
}

export interface AccessTokenRecord {
  id: string;
  profileId: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface SendOperationRecord {
  id: number;
  accountId: string;
  idempotencyKey: string;
  operation: 'send' | 'reply';
  status: OperationStatus;
  providerMessageId?: string;
  providerThreadId?: string | null;
  createdAt: string;
  updatedAt: string;
  errorCode?: string | null;
}

export interface ScopedAuthContext {
  type: 'admin' | 'profile';
  profileId?: string;
  profile?: AccessProfile & { accountIds: string[] };
  tokenId?: string;
}

export interface GmailOAuthCallbackMeta {
  connectAccountId?: string;
}
