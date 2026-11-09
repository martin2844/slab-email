import {
  AccountCapabilities, AttachmentMetadata, DraftInput, EmailAddress, EmailMessage, EmailMessageCompact,
  MessageSearchParams, OutgoingAttachment, ProviderAttachment, ProviderSendResult, ReplyInput, SendInput,
} from '../../types/models.js';
import { ApiError, ERROR_CODES } from '../../types/errors.js';
import { attachmentNotFound } from '../../utils/attachments.js';
import { clampText } from '../../utils/message.js';
import { ProviderHttpError, providerBinary, providerJson } from '../http-json.js';
import { Provider } from '../types.js';

type GraphRecipient = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  subject?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
};

type GraphAttachment = {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
};

// Graph rejects request bodies above 4 MB; inline attachments must stay well
// below that once base64-encoded. Larger files use upload sessions on a draft.
const GRAPH_INLINE_ATTACHMENTS_MAX_BYTES = 2.5 * 1024 * 1024;
const GRAPH_SMALL_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
const GRAPH_UPLOAD_CHUNK_BYTES = 320 * 1024 * 12;

const totalAttachmentBytes = (attachments?: OutgoingAttachment[]) =>
  (attachments ?? []).reduce((sum, attachment) => sum + attachment.size, 0);

const graphFileAttachment = (attachment: OutgoingAttachment) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: attachment.filename,
  contentType: attachment.contentType,
  contentBytes: attachment.contentBase64,
});

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

export type MicrosoftGraphProviderConfig = {
  emailAddress: string;
  displayName: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tenant: string;
};

const graphAddress = (value?: GraphRecipient): EmailAddress => ({
  name: value?.emailAddress?.name || undefined,
  address: (value?.emailAddress?.address || '').toLowerCase(),
});
const graphRecipients = (values: EmailAddress[] | undefined) =>
  (values ?? []).map((value) => ({ emailAddress: { name: value.name, address: value.address } }));

export class MicrosoftGraphProvider implements Provider {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly config: MicrosoftGraphProviderConfig) {}

  getProviderType(): 'microsoft_graph' { return 'microsoft_graph'; }
  getCapabilities(): AccountCapabilities {
    return { read: true, search: true, draft: true, send: true, reply: true, threads: true };
  }

  private async token() {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
      scope: 'offline_access openid profile email Mail.ReadWrite Mail.Send',
    });
    const token = await providerJson<TokenResponse>(
      `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenant)}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    );
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    return token.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const messageRequest =
      path.startsWith('/me/messages') ||
      path.startsWith('/me/mailFolders/inbox/messages');
    return providerJson<T>(`https://graph.microsoft.com/v1.0${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`, Accept: 'application/json',
        ...(messageRequest ? { Prefer: 'IdType="ImmutableId"' } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}),
      },
    });
  }

  private messagePagePath(cursor: string): string {
    let next: URL;
    try {
      next = new URL(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new Error('invalid Microsoft Graph message cursor');
    }
    if (
      next.origin !== 'https://graph.microsoft.com' ||
      !['/v1.0/me/messages', '/v1.0/me/mailFolders/inbox/messages'].includes(
        next.pathname
      )
    ) {
      throw new Error('invalid Microsoft Graph message cursor');
    }
    return `${next.pathname.slice('/v1.0'.length)}${next.search}`;
  }

  async verifyConnection() {
    const started = Date.now();
    try {
      const me = await this.request<{ mail?: string; userPrincipalName?: string }>('/me?$select=mail,userPrincipalName');
      return { status: 'ok' as const, latencyMs: Date.now() - started, providerMessage: `connected as ${me.mail || me.userPrincipalName || this.config.emailAddress}` };
    } catch (error) {
      return { status: 'error' as const, latencyMs: Date.now() - started, providerMessage: error instanceof Error ? error.message : 'Microsoft connection failed' };
    }
  }

  private compact(accountId: string, message: GraphMessage): EmailMessageCompact {
    return {
      id: message.id, accountId, threadId: message.conversationId, from: graphAddress(message.from),
      to: (message.toRecipients ?? []).map(graphAddress), subject: message.subject || '(no subject)',
      date: message.receivedDateTime || message.sentDateTime || new Date(0).toISOString(),
      snippet: clampText(message.bodyPreview || '', 340), unread: message.isRead === false,
    };
  }

  private full(accountId: string, message: GraphMessage): EmailMessage {
    const html = message.body?.contentType?.toLowerCase() === 'html' ? message.body.content : undefined;
    const text = html ? undefined : message.body?.content;
    return {
      ...this.compact(accountId, message), provider: 'microsoft_graph', messageId: message.internetMessageId,
      cc: (message.ccRecipients ?? []).map(graphAddress), bcc: (message.bccRecipients ?? []).map(graphAddress),
      html, text,
      ...(message.hasAttachments === false ? { attachments: [] } : {}),
      headers: Object.fromEntries((message.internetMessageHeaders ?? []).map(({ name, value }) => [name, value])),
    };
  }

  async searchMessages(input: MessageSearchParams) {
    const query = new URLSearchParams({
      '$top': String(Math.min(input.limit ?? 20, 100)),
      '$select': 'id,conversationId,internetMessageId,receivedDateTime,sentDateTime,subject,bodyPreview,isRead,from,toRecipients,ccRecipients,bccRecipients',
      '$orderby': 'receivedDateTime desc',
    });
    if (input.query) {
      query.set('$search', `"${input.query.replace(/"/g, '')}"`);
      query.delete('$orderby');
    }
    const filters: string[] = [];
    if (input.unread) filters.push('isRead eq false');
    if (input.since) filters.push(`receivedDateTime ge ${new Date(input.since).toISOString()}`);
    if (input.before) filters.push(`receivedDateTime lt ${new Date(input.before).toISOString()}`);
    if (filters.length) query.set('$filter', filters.join(' and '));
    const messagePath = input.inboundOnly
      ? '/me/mailFolders/inbox/messages'
      : '/me/messages';
    const result = await this.request<{ value: GraphMessage[]; '@odata.nextLink'?: string }>(input.cursor ? this.messagePagePath(input.cursor) : `${messagePath}?${query}`, {
      headers: input.query ? { ConsistencyLevel: 'eventual' } : undefined,
    });
    const from = input.from?.toLowerCase();
    const to = input.to?.toLowerCase();
    const subject = input.subject?.toLowerCase();
    const value = result.value.filter((message) =>
      (!from || graphAddress(message.from).address.includes(from)) &&
      (!to || (message.toRecipients ?? []).some((entry) => graphAddress(entry).address.includes(to))) &&
      (!subject || (message.subject || '').toLowerCase().includes(subject)),
    );
    return {
      items: value.map((message) => this.compact(input.accountId, message)),
      nextCursor: result['@odata.nextLink']
        ? Buffer.from(result['@odata.nextLink'], 'utf8').toString('base64url')
        : undefined,
    };
  }

  async getMessage(accountId: string, messageId: string) {
    const select = 'id,conversationId,internetMessageId,receivedDateTime,sentDateTime,subject,bodyPreview,isRead,hasAttachments,from,toRecipients,ccRecipients,bccRecipients,body,internetMessageHeaders';
    const message = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}?$select=${select}`);
    const full = this.full(accountId, message);
    // Note: Graph's hasAttachments is false for messages with only inline images.
    if (message.hasAttachments) {
      full.attachments = await this.listAttachments(messageId);
    }
    return full;
  }

  private async listAttachments(messageId: string): Promise<AttachmentMetadata[]> {
    const result = await this.request<{ value: GraphAttachment[] }>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    return result.value.map((attachment) => ({
      id: attachment.id,
      filename: attachment.name || 'attachment',
      contentType: (attachment.contentType || 'application/octet-stream').toLowerCase(),
      size: attachment.size ?? 0,
      inline: attachment.isInline === true,
    }));
  }

  async getAttachment(_accountId: string, messageId: string, attachmentId: string): Promise<ProviderAttachment> {
    const base = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    let attachment: GraphAttachment;
    try {
      attachment = await this.request<GraphAttachment>(`${base}?$select=id,name,contentType,size,isInline`);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) throw attachmentNotFound(attachmentId);
      throw error;
    }
    if (attachment['@odata.type'] && attachment['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      throw new ApiError(
        ERROR_CODES.NOT_SUPPORTED,
        'only file attachments can be downloaded from Microsoft 365 (item and reference attachments are not supported)',
        422,
      );
    }
    return {
      id: attachment.id,
      filename: attachment.name || 'attachment',
      contentType: (attachment.contentType || 'application/octet-stream').toLowerCase(),
      size: attachment.size,
      load: async () => (await providerBinary(`https://graph.microsoft.com/v1.0${base}/$value`, {
        headers: { Authorization: `Bearer ${await this.token()}`, Prefer: 'IdType="ImmutableId"' },
      })).data,
    };
  }

  async getThread(accountId: string, threadId: string) {
    const safeThread = threadId.replace(/'/g, "''");
    const query = new URLSearchParams({ '$filter': `conversationId eq '${safeThread}'`, '$orderby': 'receivedDateTime asc' });
    const result = await this.request<{ value: GraphMessage[] }>(`/me/messages?${query}`);
    return result.value.map((message) => this.full(accountId, message));
  }

  private messageBody(input: DraftInput, includeAttachments = true) {
    return {
      subject: input.subject,
      body: { contentType: input.html ? 'HTML' : 'Text', content: input.html || input.text },
      toRecipients: graphRecipients(input.to), ccRecipients: graphRecipients(input.cc), bccRecipients: graphRecipients(input.bcc),
      ...(includeAttachments && input.attachments?.length
        ? { attachments: input.attachments.map(graphFileAttachment) }
        : {}),
    };
  }

  private static fitsInline(attachments?: OutgoingAttachment[]) {
    return totalAttachmentBytes(attachments) <= GRAPH_INLINE_ATTACHMENTS_MAX_BYTES;
  }

  /** Adds attachments to an existing draft, using upload sessions for large files. */
  private async addDraftAttachments(draftId: string, attachments: OutgoingAttachment[]) {
    const draftPath = `/me/messages/${encodeURIComponent(draftId)}/attachments`;
    for (const attachment of attachments) {
      if (attachment.size < GRAPH_SMALL_ATTACHMENT_MAX_BYTES) {
        await this.request(draftPath, { method: 'POST', body: JSON.stringify(graphFileAttachment(attachment)) });
        continue;
      }
      const session = await this.request<{ uploadUrl: string }>(`${draftPath}/createUploadSession`, {
        method: 'POST',
        body: JSON.stringify({
          AttachmentItem: { attachmentType: 'file', name: attachment.filename, size: attachment.size, contentType: attachment.contentType },
        }),
      });
      const data = Buffer.from(attachment.contentBase64, 'base64');
      for (let start = 0; start < data.length; start += GRAPH_UPLOAD_CHUNK_BYTES) {
        const chunk = data.subarray(start, Math.min(start + GRAPH_UPLOAD_CHUNK_BYTES, data.length));
        // The pre-authenticated upload URL must not receive the bearer token.
        const response = await globalThis.fetch(session.uploadUrl, {
          method: 'PUT',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${data.length}`,
          },
          body: chunk,
          signal: globalThis.AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new ProviderHttpError(`attachment upload returned HTTP ${response.status}`, response.status);
      }
    }
  }

  private async deleteDraftQuietly(draftId: string) {
    await this.request(`/me/messages/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /**
   * Prepares a draft (attachments uploaded), then sends it. Failures before the
   * final /send call are definite failures; the draft is removed best-effort.
   */
  private async sendViaDraft(createDraft: () => Promise<{ id: string; conversationId?: string }>, prepare: (draftId: string) => Promise<void>): Promise<ProviderSendResult> {
    let draftId: string | undefined;
    try {
      const draft = await createDraft();
      draftId = draft.id;
      await prepare(draft.id);
    } catch (error) {
      if (draftId) await this.deleteDraftQuietly(draftId);
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
    await this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST' });
    return { status: 'sent' };
  }

  async createDraft(input: DraftInput) {
    const inline = MicrosoftGraphProvider.fitsInline(input.attachments);
    const draft = await this.request<{ id: string; conversationId?: string }>('/me/messages', {
      method: 'POST', body: JSON.stringify(this.messageBody(input, inline)),
    });
    if (!inline && input.attachments?.length) await this.addDraftAttachments(draft.id, input.attachments);
    return { draftId: draft.id, threadId: draft.conversationId };
  }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    const headers = [{ name: 'X-Slab-Email-Idempotency-Key', value: input.idempotencyKey }];
    if (MicrosoftGraphProvider.fitsInline(input.attachments)) {
      await this.request('/me/sendMail', {
        method: 'POST',
        body: JSON.stringify({ message: { ...this.messageBody(input), internetMessageHeaders: headers }, saveToSentItems: true }),
      });
      return { status: 'sent' };
    }
    return this.sendViaDraft(
      () => this.request<{ id: string }>('/me/messages', {
        method: 'POST', body: JSON.stringify({ ...this.messageBody(input, false), internetMessageHeaders: headers }),
      }),
      (draftId) => this.addDraftAttachments(draftId, input.attachments ?? []),
    );
  }

  async replyToMessage(input: ReplyInput): Promise<ProviderSendResult> {
    const action = input.replyAll ? 'replyAll' : 'reply';
    const source = `/me/messages/${encodeURIComponent(input.messageId)}`;
    // Graph accepts either `comment` (text, original quoted) or `message.body` (replaces the body), not both.
    const body = input.html ? { body: { contentType: 'HTML', content: input.html } } : {};
    const comment = input.html ? {} : { comment: input.text };
    if (!input.attachments?.length && !input.html) {
      await this.request(`${source}/${action}`, { method: 'POST', body: JSON.stringify({ comment: input.text }) });
      return { status: 'sent' };
    }
    if (MicrosoftGraphProvider.fitsInline(input.attachments)) {
      await this.request(`${source}/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          ...comment,
          message: { ...body, ...(input.attachments?.length ? { attachments: input.attachments.map(graphFileAttachment) } : {}) },
        }),
      });
      return { status: 'sent' };
    }
    return this.sendViaDraft(
      () => this.request<{ id: string }>(`${source}/${input.replyAll ? 'createReplyAll' : 'createReply'}`, {
        method: 'POST', body: JSON.stringify({ ...comment, ...(input.html ? { message: body } : {}) }),
      }),
      (draftId) => this.addDraftAttachments(draftId, input.attachments ?? []),
    );
  }
}
