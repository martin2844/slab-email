import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import {
  DraftInput,
  EmailAddress,
  EmailMessage,
  EmailMessageCompact,
  MessageSearchParams,
  ProviderSendResult,
  ReplyInput,
  SendInput
} from '../../types/models.js';
import { clampText, firstTextOrBody } from '../../utils/message.js';
import { Provider } from '../types.js';

const SEARCH_DEFAULT = 20;
const SEARCH_MAX = 100;
const SNIPPET_MAX = 340;

interface GmailHeaders {
  [name: string]: string;
}

interface GmailMessageHeader {
  name?: string | null;
  value?: string | null;
}

interface GmailMessageRow {
  id?: string;
  threadId?: string;
}

interface GmailPayloadPart {
  mimeType?: string;
  body?: {
    data?: string | null;
  };
  parts?: GmailPayloadPart[];
}

interface GmailRawMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string | number | null;
  labelIds?: string[];
  payload?: {
    headers?: GmailMessageHeader[];
    mimeType?: string;
    body?: { data?: string | null };
    parts?: GmailPayloadPart[];
  };
}

const getHeader = (
  headers: GmailMessageHeader[] | undefined,
  key: string
): string | undefined => {
  const target = key.toLowerCase();
  const item = (headers ?? []).find((entry) => (entry.name ?? '').toLowerCase() === target);
  return item?.value ?? undefined;
};

const parseAddressHeader = (value?: string): EmailAddress[] => {
  if (!value) return [];

  const pieces = value.split(',').map((part) => part.trim()).filter(Boolean);

  return pieces
    .map((piece) => {
      const lt = piece.lastIndexOf('<');
      const gt = piece.lastIndexOf('>');
      if (lt >= 0 && gt > lt) {
        return {
          name: piece.slice(0, lt).trim().replace(/^"|"$/g, '') || undefined,
          address: piece.slice(lt + 1, gt).trim().toLowerCase()
        };
      }
      return { address: piece.toLowerCase() } as EmailAddress;
    })
    .filter((entry): entry is EmailAddress => Boolean(entry.address));
};

const decodeBase64Url = (value?: string): string => {
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
};

const extractBody = (payload?: GmailRawMessage['payload']): { text: string; html: string } => {
  const walk = (node?: GmailRawMessage['payload'] | GmailPayloadPart | undefined): { text: string; html: string } => {
    if (!node) return { text: '', html: '' };

    const mime = (node.mimeType ?? '').toLowerCase();
    if (mime.startsWith('text/plain') && node.body?.data) {
      return { text: decodeBase64Url(node.body.data), html: '' };
    }
    if (mime.startsWith('text/html') && node.body?.data) {
      return { text: '', html: decodeBase64Url(node.body.data) };
    }

    if ((node.parts?.length ?? 0) > 0) {
      let text = '';
      let html = '';
      for (const child of node.parts ?? []) {
        const childValue = walk(child);
        if (!text && childValue.text) {
          text = childValue.text;
        }
        if (!html && childValue.html) {
          html = childValue.html;
        }
      }
      return { text, html };
    }

    return { text: '', html: '' };
  };

  return walk(payload);
};

const buildMailHeaders = (params: {
  fromName: string;
  fromAddress: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  idempotencyKey?: string;
}): string => {
  const headers = [
    `From: ${params.fromName ? `${params.fromName} <${params.fromAddress}>` : params.fromAddress}`,
    `To: ${params.to.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(', ')}`,
    params.cc?.length
      ? `Cc: ${params.cc.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(', ')}`
      : '',
    params.bcc?.length
      ? `Bcc: ${params.bcc.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(', ')}`
      : '',
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    params.inReplyTo ? `In-Reply-To: ${params.inReplyTo}` : '',
    params.references ? `References: ${params.references}` : '',
    params.idempotencyKey ? `X-Slab-Email-Idempotency-Key: ${params.idempotencyKey}` : ''
  ].filter(Boolean).join('\n');

  const body = params.html ? `${params.text}\n\n${params.html}` : params.text;
  return `${headers}\n\n${body}`;
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

export interface GmailProviderConfig {
  emailAddress: string;
  displayName: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export class GmailProvider implements Provider {
  private readonly config: GmailProviderConfig;
  private readonly client: OAuth2Client;

  constructor(config: GmailProviderConfig) {
    this.config = config;
    this.client = new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri
    });
    this.client.setCredentials({ refresh_token: config.refreshToken });
  }

  getProviderType(): 'proton_bridge' | 'imap_smtp' | 'gmail' {
    return 'gmail';
  }

  getCapabilities() {
    return {
      read: true,
      search: true,
      draft: true,
      send: true,
      reply: true,
      threads: true
    };
  }

  private async getGmailClient() {
    await this.client.getAccessToken();
    const createClient = google.gmail as unknown as (options: { version: 'v1'; auth: unknown }) => gmail_v1.Gmail;
    return createClient({
      version: 'v1',
      auth: this.client
    });
  }

  async verifyConnection(): Promise<{ status: 'ok' | 'error'; latencyMs: number; providerMessage?: string }> {
    const started = Date.now();
    try {
      const gmail = await this.getGmailClient();
      const response = await gmail.users.getProfile({ userId: 'me' });
      if (!response.data.emailAddress) {
        return {
          status: 'error',
          latencyMs: Date.now() - started,
          providerMessage: 'missing profile email'
        };
      }
      return {
        status: 'ok',
        latencyMs: Date.now() - started,
        providerMessage: `connected as ${response.data.emailAddress}`
      };
    } catch (error) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        providerMessage: String(error)
      };
    }
  }

  private buildQuery(input: MessageSearchParams): string {
    const parts: string[] = [];
    if (input.query) parts.push(input.query);
    if (input.from) parts.push(`from:${input.from}`);
    if (input.to) parts.push(`to:${input.to}`);
    if (input.subject) parts.push(`subject:${input.subject}`);
    if (input.unread) parts.push('is:unread');
    if (input.since) {
      const since = new Date(input.since);
      if (!Number.isNaN(since.getTime())) {
        parts.push(`after:${since.toISOString().split('T')[0]}`);
      }
    }
    if (input.before) {
      const before = new Date(input.before);
      if (!Number.isNaN(before.getTime())) {
        parts.push(`before:${before.toISOString().split('T')[0]}`);
      }
    }
    return parts.join(' ');
  }

  async searchMessages(input: MessageSearchParams): Promise<{ items: EmailMessageCompact[]; nextCursor?: string; total?: number }> {
    const gmail = await this.getGmailClient();
    const query = this.buildQuery(input);
    const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT, SEARCH_MAX));

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query || undefined,
      maxResults: limit,
      pageToken: input.cursor
    });

    const messages = response.data.messages ?? [];
    if (!messages.length) {
      return { items: [] };
    }

    const items: EmailMessageCompact[] = [];
    for (const row of messages as GmailMessageRow[]) {
      if (!row.id) continue;
      const details = await gmail.users.messages.get({
        userId: 'me',
        id: row.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References']
      });

      const headers = (details.data.payload?.headers ?? []) as GmailMessageHeader[];
      const subject = getHeader(headers, 'Subject') ?? '(no subject)';
      const from = parseAddressHeader(getHeader(headers, 'From'));
      const to = parseAddressHeader(getHeader(headers, 'To'));
      const messageId = getHeader(headers, 'Message-ID') ?? row.id;
      const inReplyTo = getHeader(headers, 'In-Reply-To') ?? null;
      const refs = getHeader(headers, 'References')
        ?.split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
      const unread = !(details.data.labelIds ?? []).includes('UNREAD');

      items.push({
        id: row.id,
        accountId: this.config.emailAddress,
        threadId: details.data.threadId ?? null,
        from: from[0] ?? { address: '' },
        to,
        subject,
        date: toCompactDate(details.data.internalDate),
        snippet: clampText(details.data.snippet ?? subject, SNIPPET_MAX),
        unread
      });
    }

    return {
      items,
      nextCursor: response.data.nextPageToken || undefined,
      total: messages.length
    };
  }

  async getMessage(accountId: string, messageId: string): Promise<EmailMessage> {
    const gmail = await this.getGmailClient();
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    if (!response.data.payload) {
      throw new Error('message not found');
    }

      const headers = (response.data.payload?.headers ?? []) as GmailMessageHeader[];
    const body = extractBody(response.data.payload as GmailRawMessage['payload']);
    const messageText = firstTextOrBody(body.text, body.html);
    const msgIdValue = getHeader(headers, 'Message-ID') ?? messageId;

    return {
      id: messageId,
      accountId,
      provider: 'gmail',
      threadId: response.data.threadId ?? null,
      messageId: msgIdValue,
      inReplyTo: getHeader(headers, 'In-Reply-To') ?? null,
      references: getHeader(headers, 'References')
        ?.split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [],
      from: parseAddressHeader(getHeader(headers, 'From'))[0] ?? { address: '' },
      to: parseAddressHeader(getHeader(headers, 'To')),
      cc: parseAddressHeader(getHeader(headers, 'Cc')),
      bcc: parseAddressHeader(getHeader(headers, 'Bcc')),
      subject: getHeader(headers, 'Subject') ?? '(no subject)',
      date: toCompactDate(response.data.internalDate),
      snippet: clampText(response.data.snippet ?? messageText),
      unread: !(response.data.labelIds ?? []).includes('UNREAD'),
      text: body.text,
      html: body.html,
      headers: headers.reduce<GmailHeaders>((acc, entry) => {
        const headerName = entry.name;
        if (headerName) {
          acc[headerName.toLowerCase()] = entry.value ?? '';
        }
        return acc;
      }, {})
    };
  }

  async getThread(_accountId: string, threadId: string): Promise<EmailMessage[]> {
    const gmail = await this.getGmailClient();
    const response = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });

    const out: EmailMessage[] = [];
    for (const item of response.data.messages ?? []) {
      if (!item.id) continue;
      out.push(await this.getMessage(_accountId, item.id));
    }

    return out;
  }

  async createDraft(input: DraftInput): Promise<{ draftId: string; threadId?: string | null }> {
    const gmail = await this.getGmailClient();
    const raw = base64UrlEncode(
      buildMailHeaders({
        fromName: this.config.displayName,
        fromAddress: this.config.emailAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html
      })
    );

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } }
    });

    return {
      draftId: draft.data.id ?? crypto.randomUUID(),
      threadId: draft.data.message?.threadId ?? null
    };
  }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    const gmail = await this.getGmailClient();
    const raw = base64UrlEncode(
      buildMailHeaders({
        fromName: this.config.displayName,
        fromAddress: this.config.emailAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        idempotencyKey: input.idempotencyKey
      })
    );

    try {
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw }
      });
      return {
        status: 'sent',
        providerMessageId: response.data.id ?? undefined,
        providerThreadId: response.data.threadId ?? null
      };
    } catch (error) {
      return formatProviderError(error);
    }
  }

  async replyToMessage(input: ReplyInput): Promise<ProviderSendResult> {
    const gmail = await this.getGmailClient();
    const original = await this.getMessage(this.config.emailAddress, input.messageId);

    const to = input.to?.length ? input.to : [original.from];
    const cc = input.replyAll ? [...original.to, ...original.cc] : [];
    const refs = [...(original.references ?? []), original.messageId ?? '', original.inReplyTo ?? ''].filter(Boolean);
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;

    const raw = base64UrlEncode(
      buildMailHeaders({
        fromName: this.config.displayName,
        fromAddress: this.config.emailAddress,
        to,
        cc,
        subject,
        text: input.text,
        html: input.html,
        inReplyTo: original.messageId,
        references: refs.join(' '),
        idempotencyKey: input.idempotencyKey
      })
    );

    try {
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          threadId: original.threadId ?? undefined,
          raw
        }
      });
      return {
        status: 'sent',
        providerMessageId: response.data.id ?? undefined,
        providerThreadId: response.data.threadId ?? original.threadId ?? null
      };
    } catch (error) {
      return formatProviderError(error);
    }
  }

  static buildAuthorizationUrl(opts: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    codeChallenge: string;
  }): string {
    const client = new OAuth2Client({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: opts.redirectUri
    });

    const authUrlOptions: Record<string, unknown> = {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: false,
      scope: opts.scopes,
      state: opts.state,
      code_challenge: opts.codeChallenge
    };
    authUrlOptions.code_challenge_method = 'S256';

    return client.generateAuthUrl(authUrlOptions as Parameters<typeof client.generateAuthUrl>[0]);
  }
}

const toCompactDate = (raw?: string | number | null): string => {
  if (!raw) return new Date().toISOString();
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw);
  if (Number.isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
};

const formatProviderError = (error: unknown): ProviderSendResult => {
  const responseMessage = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data;
  if (responseMessage?.error?.message) {
    return { status: 'failed', detail: responseMessage.error.message };
  }
  return {
    status: 'failed',
    detail: String((error as { message?: string }).message ?? error)
  };
};
