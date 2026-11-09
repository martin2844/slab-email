import {
  AccountCapabilities,
  DraftInput,
  EmailMessage,
  EmailMessageCompact,
  MessageSearchParams,
  OutgoingAttachment,
  ProviderAttachment,
  ProviderSendResult,
  ReplyInput,
  SendInput,
} from '../../types/models.js';
import { attachmentNotFound } from '../../utils/attachments.js';
import { clampText } from '../../utils/message.js';
import { ProviderHttpError, downloadSignedUrl, formatAddress, parseAddress, providerBinary, providerJson } from '../http-json.js';
import { Provider } from '../types.js';

type AgentMailMessage = {
  message_id: string;
  thread_id?: string;
  labels?: string[];
  timestamp?: string;
  created_at?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  in_reply_to?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: AgentMailAttachment[];
};

type AgentMailAttachment = {
  attachment_id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  content_disposition?: string;
  inline?: boolean;
  download_url?: string;
};

const agentMailAttachments = (attachments?: OutgoingAttachment[]) =>
  attachments?.length
    ? attachments.map((attachment) => ({
        filename: attachment.filename,
        content_type: attachment.contentType,
        content: attachment.contentBase64,
      }))
    : undefined;

export type AgentMailProviderConfig = {
  emailAddress: string;
  displayName: string;
  inboxId: string;
  apiKey: string;
  baseUrl: string;
};

export class AgentMailProvider implements Provider {
  constructor(private readonly config: AgentMailProviderConfig) {}

  getProviderType(): 'agentmail' {
    return 'agentmail';
  }

  getCapabilities(): AccountCapabilities {
    return { read: true, search: true, draft: true, send: true, reply: true, threads: true };
  }

  private url(path: string) {
    return `${this.config.baseUrl.replace(/\/$/, '')}/inboxes/${encodeURIComponent(this.config.inboxId)}${path}`;
  }

  private request<T>(path: string, init: RequestInit = {}) {
    return providerJson<T>(this.url(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  async verifyConnection() {
    const started = Date.now();
    try {
      await this.request<{ inbox_id: string }>('', { method: 'GET' });
      return { status: 'ok' as const, latencyMs: Date.now() - started, providerMessage: `connected to ${this.config.inboxId}` };
    } catch (error) {
      return { status: 'error' as const, latencyMs: Date.now() - started, providerMessage: error instanceof Error ? error.message : 'AgentMail connection failed' };
    }
  }

  private compact(message: AgentMailMessage): EmailMessageCompact {
    return {
      id: message.message_id,
      accountId: '',
      threadId: message.thread_id,
      from: parseAddress(message.from),
      to: (message.to ?? []).map(parseAddress),
      subject: message.subject || '(no subject)',
      date: message.timestamp || message.created_at || new Date(0).toISOString(),
      snippet: clampText(message.preview || message.extracted_text || message.text || '', 340),
      unread: message.labels?.includes('unread'),
    };
  }

  private full(accountId: string, message: AgentMailMessage): EmailMessage {
    return {
      ...this.compact(message),
      accountId,
      provider: 'agentmail',
      messageId: message.message_id,
      inReplyTo: message.in_reply_to,
      references: message.references,
      cc: (message.cc ?? []).map(parseAddress),
      bcc: (message.bcc ?? []).map(parseAddress),
      text: message.extracted_text || message.text,
      html: message.html,
      headers: message.headers,
      attachments: (message.attachments ?? []).map((attachment) => ({
        id: attachment.attachment_id,
        filename: attachment.filename || 'attachment',
        contentType: (attachment.content_type || 'application/octet-stream').toLowerCase(),
        size: attachment.size ?? 0,
        inline: attachment.inline === true || attachment.content_disposition === 'inline',
      })),
    };
  }

  private isReceived(message: AgentMailMessage): boolean {
    const sender = parseAddress(message.from).address.trim().toLowerCase();
    return sender !== this.config.emailAddress.trim().toLowerCase();
  }

  async searchMessages(input: MessageSearchParams) {
    const query = new URLSearchParams({ limit: String(Math.min(input.limit ?? 20, 100)) });
    if (input.cursor) query.set('page_token', input.cursor);
    if (input.since) query.set('after', input.since);
    if (input.before) query.set('before', input.before);
    if (input.from) query.append('from', input.from);
    if (input.to) query.append('to', input.to);
    if (input.subject) query.append('subject', input.subject);
    if (input.unread) query.append('labels', 'unread');
    const endpoint = input.query ? '/messages/search' : '/messages';
    if (input.query) query.set('q', input.query);
    const result = await this.request<{ messages: AgentMailMessage[]; next_page_token?: string }>(`${endpoint}?${query}`);
    const messages = input.inboundOnly
      ? result.messages.filter((message) => this.isReceived(message))
      : result.messages;
    return { items: messages.map((message) => ({ ...this.compact(message), accountId: input.accountId })), nextCursor: result.next_page_token };
  }

  async getMessage(accountId: string, messageId: string) {
    const message = await this.request<AgentMailMessage>(`/messages/${encodeURIComponent(messageId)}`);
    return this.full(accountId, message);
  }

  async getAttachment(_accountId: string, messageId: string, attachmentId: string): Promise<ProviderAttachment> {
    const message = await this.request<AgentMailMessage>(`/messages/${encodeURIComponent(messageId)}`);
    const metadata = (message.attachments ?? []).find((entry) => entry.attachment_id === attachmentId);
    if (!metadata) throw attachmentNotFound(attachmentId);
    const url = this.url(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return {
      id: metadata.attachment_id,
      filename: metadata.filename || 'attachment',
      contentType: (metadata.content_type || 'application/octet-stream').toLowerCase(),
      size: metadata.size,
      load: async () => {
        let response: { data: Buffer; contentType?: string };
        try {
          response = await providerBinary(url, { headers: { Authorization: `Bearer ${this.config.apiKey}` } });
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 404) throw attachmentNotFound(attachmentId);
          throw error;
        }
        // Newer API versions return JSON with a pre-signed download_url; older ones stream the bytes.
        if (response.contentType?.toLowerCase().includes('application/json') && metadata.content_type !== 'application/json') {
          const parsed = JSON.parse(response.data.toString('utf8')) as { download_url?: string };
          if (!parsed.download_url) throw new Error('AgentMail did not return attachment content');
          return downloadSignedUrl(parsed.download_url);
        }
        return response.data;
      },
    };
  }

  async getThread(accountId: string, threadId: string) {
    const thread = await this.request<{ messages: AgentMailMessage[] }>(`/threads/${encodeURIComponent(threadId)}`);
    return thread.messages.map((message) => this.full(accountId, message));
  }

  async createDraft(input: DraftInput) {
    const draft = await this.request<{ draft_id: string; thread_id?: string }>('/drafts', {
      method: 'POST',
      body: JSON.stringify({
        to: input.to.map(formatAddress), cc: input.cc?.map(formatAddress), bcc: input.bcc?.map(formatAddress),
        subject: input.subject, text: input.text, html: input.html,
        attachments: agentMailAttachments(input.attachments),
      }),
    });
    return { draftId: draft.draft_id, threadId: draft.thread_id };
  }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    const sent = await this.request<{ message_id: string; thread_id?: string }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        to: input.to.map(formatAddress), cc: input.cc?.map(formatAddress), bcc: input.bcc?.map(formatAddress),
        subject: input.subject, text: input.text, html: input.html,
        attachments: agentMailAttachments(input.attachments),
        headers: { 'X-Slab-Email-Idempotency-Key': input.idempotencyKey },
      }),
    });
    return { status: 'sent', providerMessageId: sent.message_id, providerThreadId: sent.thread_id };
  }

  async replyToMessage(input: ReplyInput): Promise<ProviderSendResult> {
    const sent = await this.request<{ message_id: string; thread_id?: string }>(`/messages/${encodeURIComponent(input.messageId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        to: input.to?.map(formatAddress), cc: input.cc?.map(formatAddress), reply_all: input.replyAll,
        text: input.text, html: input.html,
        attachments: agentMailAttachments(input.attachments),
        headers: { 'X-Slab-Email-Idempotency-Key': input.idempotencyKey },
      }),
    });
    return { status: 'sent', providerMessageId: sent.message_id, providerThreadId: sent.thread_id };
  }
}
