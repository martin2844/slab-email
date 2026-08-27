import {
  AccountCapabilities, DraftInput, EmailAddress, EmailMessage, EmailMessageCompact,
  MessageSearchParams, ProviderSendResult, ReplyInput, SendInput,
} from '../../types/models.js';
import { clampText } from '../../utils/message.js';
import { providerJson } from '../http-json.js';
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
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
};

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
    const select = 'id,conversationId,internetMessageId,receivedDateTime,sentDateTime,subject,bodyPreview,isRead,from,toRecipients,ccRecipients,bccRecipients,body,internetMessageHeaders';
    const message = await this.request<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}?$select=${select}`);
    return this.full(accountId, message);
  }

  async getThread(accountId: string, threadId: string) {
    const safeThread = threadId.replace(/'/g, "''");
    const query = new URLSearchParams({ '$filter': `conversationId eq '${safeThread}'`, '$orderby': 'receivedDateTime asc' });
    const result = await this.request<{ value: GraphMessage[] }>(`/me/messages?${query}`);
    return result.value.map((message) => this.full(accountId, message));
  }

  private messageBody(input: DraftInput) {
    return {
      subject: input.subject,
      body: { contentType: input.html ? 'HTML' : 'Text', content: input.html || input.text },
      toRecipients: graphRecipients(input.to), ccRecipients: graphRecipients(input.cc), bccRecipients: graphRecipients(input.bcc),
    };
  }

  async createDraft(input: DraftInput) {
    const draft = await this.request<{ id: string; conversationId?: string }>('/me/messages', {
      method: 'POST', body: JSON.stringify(this.messageBody(input)),
    });
    return { draftId: draft.id, threadId: draft.conversationId };
  }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    await this.request('/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({ message: { ...this.messageBody(input), internetMessageHeaders: [{ name: 'X-Slab-Email-Idempotency-Key', value: input.idempotencyKey }] }, saveToSentItems: true }),
    });
    return { status: 'sent' };
  }

  async replyToMessage(input: ReplyInput): Promise<ProviderSendResult> {
    await this.request(`/me/messages/${encodeURIComponent(input.messageId)}/${input.replyAll ? 'replyAll' : 'reply'}`, {
      method: 'POST', body: JSON.stringify({ comment: input.text }),
    });
    return { status: 'sent' };
  }
}
