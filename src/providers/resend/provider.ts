import {
  AccountCapabilities, DraftInput, EmailMessage, EmailMessageCompact, MessageSearchParams,
  ProviderSendResult, ReplyInput, SendInput,
} from '../../types/models.js';
import { clampText } from '../../utils/message.js';
import { formatAddress, parseAddress, providerJson } from '../http-json.js';
import { Provider } from '../types.js';

type ResendMessage = {
  id: string; message_id?: string; from: string; to: string[]; cc?: string[]; bcc?: string[];
  received_for?: string[]; subject?: string; created_at: string; text?: string | null; html?: string | null; headers?: Record<string, string>;
};

export type ResendProviderConfig = {
  emailAddress: string; displayName: string; apiKey: string; baseUrl: string; inboundEnabled: boolean;
};

export class ResendProvider implements Provider {
  constructor(private readonly config: ResendProviderConfig) {}

  getProviderType(): 'resend' { return 'resend'; }
  getCapabilities(): AccountCapabilities {
    return { read: this.config.inboundEnabled, search: this.config.inboundEnabled, draft: false, send: true, reply: false, threads: false };
  }

  private request<T>(path: string, init: RequestInit = {}) {
    return providerJson<T>(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`, Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}),
      },
    });
  }

  async verifyConnection() {
    const started = Date.now();
    try {
      if (this.config.inboundEnabled) await this.request('/emails/receiving');
      else await this.request('/emails?limit=1');
      return { status: 'ok' as const, latencyMs: Date.now() - started, providerMessage: 'Resend API connected' };
    } catch (error) {
      return { status: 'error' as const, latencyMs: Date.now() - started, providerMessage: error instanceof Error ? error.message : 'Resend connection failed' };
    }
  }

  private compact(accountId: string, message: ResendMessage): EmailMessageCompact {
    return {
      id: message.id, accountId, from: parseAddress(message.from), to: message.to.map(parseAddress),
      subject: message.subject || '(no subject)', date: message.created_at,
      snippet: clampText(message.text || '', 340), unread: undefined,
    };
  }

  private belongsToAccount(message: ResendMessage) {
    const target = this.config.emailAddress.toLowerCase();
    return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? []), ...(message.received_for ?? [])]
      .map((address) => parseAddress(address).address)
      .includes(target);
  }

  async searchMessages(input: MessageSearchParams) {
    const query = new URLSearchParams({ limit: String(Math.min(input.limit ?? 20, 100)) });
    if (input.cursor) query.set('after', input.cursor);
    const result = await this.request<{ data: ResendMessage[]; has_more?: boolean }>(`/emails/receiving?${query}`);
    const needle = (input.query || input.subject || '').toLowerCase();
    const items = result.data
      .filter((message) => this.belongsToAccount(message))
      .filter((message) => !needle || `${message.subject || ''} ${message.from}`.toLowerCase().includes(needle))
      .map((message) => this.compact(input.accountId, message));
    return { items, nextCursor: result.has_more ? result.data.at(-1)?.id : undefined };
  }

  async getMessage(accountId: string, messageId: string): Promise<EmailMessage> {
    const message = await this.request<ResendMessage>(`/emails/receiving/${encodeURIComponent(messageId)}`);
    if (!this.belongsToAccount(message)) throw new Error('Received email is outside this account scope');
    return {
      ...this.compact(accountId, message), provider: 'resend', messageId: message.message_id,
      cc: (message.cc ?? []).map(parseAddress), bcc: (message.bcc ?? []).map(parseAddress),
      text: message.text || undefined, html: message.html || undefined, headers: message.headers,
    };
  }

  async getThread(): Promise<EmailMessage[]> { throw new Error('Threads are not supported by Resend'); }
  async createDraft(_input: DraftInput): Promise<{ draftId: string }> { throw new Error('Drafts are not supported by Resend'); }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    const sent = await this.request<{ id: string }>('/emails', {
      method: 'POST', headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        from: formatAddress({ name: this.config.displayName, address: this.config.emailAddress }),
        to: input.to.map(formatAddress), cc: input.cc?.map(formatAddress), bcc: input.bcc?.map(formatAddress),
        subject: input.subject, text: input.text, html: input.html,
      }),
    });
    return { status: 'sent', providerMessageId: sent.id };
  }

  async replyToMessage(_input: ReplyInput): Promise<ProviderSendResult> { throw new Error('Replies are not supported by Resend'); }
}
