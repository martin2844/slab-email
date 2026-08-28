import crypto from "node:crypto";
import fs from 'node:fs';
import { ImapFlow, type ImapFlowOptions, type SearchObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer, { type SentMessageInfo, type Transporter } from 'nodemailer';

import {
  AccountCapabilities,
  DraftInput,
  EmailAddress,
  EmailMessage,
  EmailMessageCompact,
  MessageSearchParams,
  ProviderSendResult,
  ReplyInput,
  SendInput
} from '../../types/models.js';
import { clampText, firstTextOrBody, normalizeAddressList } from '../../utils/message.js';
import { Provider } from '../types.js';
import type { GenericImapSmtpProviderConfig } from './types.js';

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  'host.docker.internal'
]);
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SNIPPET_MAX = 340;

type ImapErrorEmitter = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

export const guardImapClientErrors = <T extends ImapErrorEmitter>(client: T): T => {
  // ImapFlow emits socket failures in addition to rejecting the active command.
  // Without an error listener, a late timeout becomes an uncaught EventEmitter
  // error and terminates the whole connector process.
  client.on('error', () => undefined);
  return client;
};

export const formatImapMessageId = (
  uidValidity: bigint | string,
  uid: number,
  connectionFingerprint?: string
): string => connectionFingerprint
  ? `${connectionFingerprint}:${uidValidity}:${uid}`
  : `${uidValidity}:${uid}`;

export const parseImapMessageId = (
  value: string
): { uid: number; uidValidity?: string; connectionFingerprint?: string } => {
  const current = value.match(/^([a-f0-9]{24}):(\d+):(\d+)$/);
  const legacyQualified = value.match(/^(\d+):(\d+)$/);
  const legacyBare = value.match(/^(\d+)$/);
  const uid = Number.parseInt(
    current?.[3] ?? legacyQualified?.[2] ?? legacyBare?.[1] ?? '',
    10
  );
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error('invalid message id');
  }
  return {
    uid,
    uidValidity: current?.[2] ?? legacyQualified?.[1],
    connectionFingerprint: current?.[1]
  };
};

export const formatImapConnectionFingerprint = (input: {
  host: string;
  port: number;
  username: string;
}): string => {
  const connection = [
    input.host.trim().toLowerCase(),
    String(input.port),
    input.username.trim(),
    'INBOX'
  ].join('\n');
  return crypto
    .createHash('sha256')
    .update(connection)
    .digest('hex')
    .slice(0, 24);
};

export const formatImapIdentityEpoch = (input: {
  host: string;
  port: number;
  username: string;
  uidValidity: bigint | string;
}): string =>
  `imap:${formatImapConnectionFingerprint(input)}:uidvalidity:${input.uidValidity}`;

export const assertImapMessageIdentity = (
  expected: ReturnType<typeof parseImapMessageId>,
  current: { uidValidity: string; connectionFingerprint: string }
): void => {
  if (
    (expected.connectionFingerprint &&
      expected.connectionFingerprint !== current.connectionFingerprint) ||
    (expected.uidValidity && expected.uidValidity !== current.uidValidity)
  ) {
    throw new Error('message not found');
  }
};

const formatImapSearchCursor = (input: {
  uidValidity: string;
  connectionFingerprint: string;
  beforeUid: number;
}): string =>
  `${input.connectionFingerprint}:${input.uidValidity}:before:${input.beforeUid}`;

export const paginateImapUids = (input: {
  messageIds: number[];
  cursor?: string;
  limit: number;
  uidValidity: string;
  connectionFingerprint: string;
}): { uids: number[]; nextCursor?: string } => {
  const parsedCursor = input.cursor?.match(
    /^([a-f0-9]{24}):(\d+):before:(\d+)$/
  );
  if (input.cursor && !parsedCursor) throw new Error('invalid IMAP cursor');
  if (
    parsedCursor &&
    (parsedCursor[1] !== input.connectionFingerprint ||
      parsedCursor[2] !== input.uidValidity)
  ) {
    throw new Error('IMAP cursor mailbox changed');
  }
  const beforeUid = parsedCursor
    ? Number.parseInt(parsedCursor[3]!, 10)
    : undefined;
  if (beforeUid !== undefined && (!Number.isFinite(beforeUid) || beforeUid <= 0)) {
    throw new Error('invalid IMAP cursor');
  }
  const eligible = [...new Set(input.messageIds)]
    .filter((uid) => beforeUid === undefined || uid < beforeUid)
    .sort((left, right) => right - left);
  const uids = eligible.slice(0, input.limit);
  const boundary = uids.at(-1);
  return {
    uids,
    nextCursor: eligible.length > input.limit && boundary !== undefined
      ? formatImapSearchCursor({
          uidValidity: input.uidValidity,
          connectionFingerprint: input.connectionFingerprint,
          beforeUid: boundary
        })
      : undefined
  };
};

const closeSmtpTransport = (transport: Transporter): void => {
  (transport as Transporter & { close?: () => void }).close?.();
};

const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host);

const toHeaderList = (addresses: EmailAddress[]): string[] =>
  addresses
    .filter((entry) => Boolean(entry.address))
    .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address));

const normalizeDomain = (value: string): string => {
  const at = value.lastIndexOf('@');
  return at === -1 ? 'localhost' : value.slice(at + 1);
};

export const buildImapThreadId = (
  inReplyTo?: string | null,
  references?: string[],
  messageId?: string | null
): string | null => {
  if (references && references.length > 0) return references[0];
  return inReplyTo ?? messageId ?? null;
};

export const formatSyntheticImapMessageId = (
  providerIdentity: string
): string => {
  const digest = crypto
    .createHash('sha256')
    .update(providerIdentity)
    .digest('hex')
    .slice(0, 32);
  return `<${digest}@slab-email.invalid>`;
};

export const buildImapReplyReferences = (input: {
  references?: string[];
  inReplyTo?: string | null;
  messageId: string;
}): string[] => {
  const ancestry = input.references?.length
    ? input.references
    : input.inReplyTo
      ? [input.inReplyTo]
      : [];
  return [...new Set([...ancestry, input.messageId].filter(Boolean))];
};

interface ParsedMessageSource {
  text: string;
  html: string;
  subject: string;
  date: string;
  inReplyTo: string | null;
  references: string[];
  messageId: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
}

const parseMessageSource = async (source: Buffer | string): Promise<ParsedMessageSource> => {
  const parsed = (await simpleParser(source)) as ParsedMail;
  const refs = parsed.references ?? [];

const normalizeAddressListSafe = (value: unknown): EmailAddress[] => {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((entry: { address?: string; name?: string }) => ({
        name: entry.name,
        address: (entry.address ?? '').toLowerCase()
      }))
      .filter((entry): entry is { name: string | undefined; address: string } => Boolean(entry.address));

    return normalizeAddressList(normalized);
  };

    return {
      text: (parsed.text || '').toString().trim(),
      html: (parsed.html || '').toString().trim(),
      subject: (parsed.subject || '(no subject)').toString().trim(),
      date: parsed.date
        ? parsed.date instanceof Date
          ? parsed.date.toISOString()
          : new Date(parsed.date).toISOString()
        : new Date().toISOString(),
    inReplyTo: parsed.inReplyTo ? parsed.inReplyTo.trim() : null,
    references: Array.isArray(refs) ? refs : [],
    messageId: parsed.messageId ? parsed.messageId.trim() : null,
    from: normalizeAddressListSafe(parsed.from?.value),
    to: normalizeAddressListSafe(parsed.to?.value),
    cc: normalizeAddressListSafe(parsed.cc?.value),
    bcc: normalizeAddressListSafe(parsed.bcc?.value)
  };
};

interface ImapTransportOptions {
  secure: boolean;
  tls: {
    servername: string;
    rejectUnauthorized: boolean;
    ca?: Buffer;
  };
  starttls?: { enable: boolean };
  requireTLS?: boolean;
}

const buildTransportOptions = (
  tlsMode: GenericImapSmtpProviderConfig['imap']['imapTlsMode'] | GenericImapSmtpProviderConfig['smtp']['smtpTlsMode'],
  host: string,
  customCA?: string,
  allowInsecure?: boolean
): ImapTransportOptions => {
  const tls: { servername: string; rejectUnauthorized: boolean; ca?: Buffer } = {
    servername: host,
    rejectUnauthorized: true
  };

  if (customCA) {
    const caContent = fsSafeRead(customCA);
    tls.ca = caContent;
  } else if (allowInsecure) {
    if (!isLoopbackHost(host)) {
      throw new Error('allowInsecure can only be used for loopback hosts');
    }
    tls.rejectUnauthorized = false;
  }

  if (tlsMode === 'ssl') {
    return {
      secure: true,
      tls
    };
  }

  if (tlsMode === 'starttls') {
    return {
      secure: false,
      tls,
      requireTLS: true,
      starttls: { enable: true }
    };
  }

  return {
    secure: false,
    tls
  };
};

const fsSafeRead = (value: string): Buffer => {
  if (!fs.existsSync(value)) {
    return Buffer.from(value);
  }
  return fs.readFileSync(value);
};

export class GenericImapSmtpProvider implements Provider {
  private readonly emailAddress: string;
  private readonly displayName: string;
  private readonly imapHost: string;
  private readonly imapPort: number;
  private readonly imapTlsMode: GenericImapSmtpProviderConfig['imap']['imapTlsMode'];
  private readonly imapCustomCa?: string;
  private readonly imapAllowInsecure?: boolean;
  private readonly imapUsername: string;
  private readonly imapPassword: string;

  private readonly smtpHost: string;
  private readonly smtpPort: number;
  private readonly smtpTlsMode: GenericImapSmtpProviderConfig['smtp']['smtpTlsMode'];
  private readonly smtpCustomCa?: string;
  private readonly smtpAllowInsecure?: boolean;
  private readonly smtpUsername: string;
  private readonly smtpPassword: string;
  private readonly smtpMessageIdDomain?: string;

  constructor(cfg: GenericImapSmtpProviderConfig) {
    this.emailAddress = cfg.emailAddress.trim().toLowerCase();
    this.displayName = cfg.displayName?.trim() || this.emailAddress;
    this.imapHost = cfg.imap.imapHost;
    this.imapPort = cfg.imap.imapPort;
    this.imapTlsMode = cfg.imap.imapTlsMode;
    this.imapCustomCa = cfg.imap.imapCustomCa;
    this.imapAllowInsecure = cfg.imap.imapAllowInsecure;
    this.imapUsername = cfg.imap.username;
    this.imapPassword = cfg.imap.password;

    this.smtpHost = cfg.smtp.smtpHost;
    this.smtpPort = cfg.smtp.smtpPort;
    this.smtpTlsMode = cfg.smtp.smtpTlsMode;
    this.smtpCustomCa = cfg.smtp.smtpCustomCa;
    this.smtpAllowInsecure = cfg.smtp.smtpAllowInsecure;
    this.smtpUsername = cfg.smtp.username;
    this.smtpPassword = cfg.smtp.password;
    this.smtpMessageIdDomain = cfg.smtp.smtpMessageIdDomain || normalizeDomain(this.emailAddress);
  }

  getProviderType(): 'proton_bridge' | 'imap_smtp' {
    return 'imap_smtp';
  }

  getCapabilities(): AccountCapabilities {
    return {
      read: true,
      search: true,
      draft: false,
      send: true,
      reply: true,
      threads: false
    };
  }

  private buildImapClient(): ImapFlow {
    const imapTlsOptions = buildTransportOptions(this.imapTlsMode, this.imapHost, this.imapCustomCa, this.imapAllowInsecure);

    const options: ImapFlowOptions = {
      host: this.imapHost,
      port: this.imapPort,
      auth: {
        user: this.imapUsername,
        pass: this.imapPassword
      },
      secure: imapTlsOptions.secure,
      tls: imapTlsOptions.tls,
      disableAutoIdle: true
    };

    return guardImapClientErrors(new ImapFlow(options));
  }

  private buildSmtpTransport(): Transporter {
    const smtpTlsOptions = buildTransportOptions(this.smtpTlsMode, this.smtpHost, this.smtpCustomCa, this.smtpAllowInsecure);

    return nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      secure: smtpTlsOptions.secure,
      auth: {
        user: this.smtpUsername,
        pass: this.smtpPassword
      },
      tls: smtpTlsOptions.tls,
      requireTLS: smtpTlsOptions.requireTLS,
      starttls: smtpTlsOptions.starttls
    });
  }

  private buildSearchCriteria(input: MessageSearchParams): SearchObject {
    const criteria: SearchObject = {};
    if (input.from) criteria.from = input.from;
    if (input.to) criteria.to = input.to;
    if (input.subject) criteria.subject = input.subject;
    if (input.query) criteria.text = input.query;
    if (input.since) criteria.since = new Date(input.since);
    if (input.before) criteria.before = new Date(input.before);
    if (input.unread) criteria.seen = false;
    return criteria;
  }

  private async fetchMessageByUid(
    client: ImapFlow,
    uid: number,
    includeSource = false
  ): Promise<{
    id: string;
    parsed: ParsedMessageSource;
    flags?: Set<string>;
    internalDate?: Date | string;
  } | null> {
    const fetched = await client.fetchOne(`${uid}`,
      {
        uid: true,
        source: includeSource,
        envelope: true,
        internalDate: true,
        flags: true
      },
      {
        uid: true
      }
    );

    if (!fetched || !fetched.source) {
      return null;
    }

    const parsed = await parseMessageSource(fetched.source);
    return {
      id: String(uid),
      parsed,
      flags: fetched.flags,
      internalDate: fetched.internalDate
    };
  }

  async verifyConnection(): Promise<{ status: 'ok' | 'error'; latencyMs: number; providerMessage?: string }> {
    const started = Date.now();
    const imap = this.buildImapClient();
    const smtp = this.buildSmtpTransport();

    try {
      await imap.connect();
      await imap.noop();
      await imap.logout();
      await smtp.verify();
      return {
        status: 'ok',
        latencyMs: Date.now() - started,
        providerMessage: 'IMAP+SMTP verified'
      };
    } catch (error) {
      try {
        await imap.logout();
      } catch {
        // ignore cleanup
      }
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        providerMessage: String(error)
      };
    } finally {
      closeSmtpTransport(smtp);
    }
  }

  async searchMessages(
    input: MessageSearchParams
  ): Promise<{
    items: EmailMessageCompact[];
    nextCursor?: string;
    total?: number;
    identityEpoch?: string;
  }> {
    const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));

    const client = this.buildImapClient();
    await client.connect();

    try {
      const mailboxLock = await client.getMailboxLock('INBOX');
      try {
        if (!client.mailbox) throw new Error('mailbox is not open');
        const uidValidity = client.mailbox.uidValidity.toString();
        const connectionFingerprint = formatImapConnectionFingerprint({
          host: this.imapHost,
          port: this.imapPort,
          username: this.imapUsername
        });
        const messageIds = (await client.search(this.buildSearchCriteria(input), { uid: true })) as number[];
        const page = paginateImapUids({
          messageIds,
          cursor: input.cursor,
          limit,
          uidValidity,
          connectionFingerprint
        });
        const items: EmailMessageCompact[] = [];

        for (const uid of page.uids) {
          const fetched = await this.fetchMessageByUid(client, uid, true);
          if (!fetched) continue;

          const parsed = fetched.parsed;
          const providerIdentity = formatImapMessageId(
            uidValidity,
            uid,
            connectionFingerprint
          );
          const rfcMessageId =
            parsed.messageId ?? formatSyntheticImapMessageId(providerIdentity);
          const snippet = clampText(firstTextOrBody(parsed.text, parsed.html), SNIPPET_MAX);
          items.push({
            id: providerIdentity,
            accountId: '',
            threadId: buildImapThreadId(
              parsed.inReplyTo,
              parsed.references,
              rfcMessageId
            ),
            from: parsed.from[0] ?? { address: '' },
            to: parsed.to,
            subject: parsed.subject,
            date: parsed.date,
            snippet,
            unread: !fetched.flags?.has('\\Seen')
          });
        }

        return {
          items,
          nextCursor: page.nextCursor,
          total: messageIds.length,
          identityEpoch: formatImapIdentityEpoch({
            host: this.imapHost,
            port: this.imapPort,
            username: this.imapUsername,
            uidValidity
          })
        };
      } finally {
        mailboxLock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async getMessage(accountId: string, messageId: string): Promise<EmailMessage> {
    const {
      uid,
      uidValidity: expectedUidValidity,
      connectionFingerprint: expectedConnectionFingerprint
    } =
      parseImapMessageId(messageId);

    const client = this.buildImapClient();
    await client.connect();

    try {
      const mailboxLock = await client.getMailboxLock('INBOX');
      try {
        if (!client.mailbox) throw new Error('mailbox is not open');
        const uidValidity = client.mailbox.uidValidity.toString();
        const connectionFingerprint = formatImapConnectionFingerprint({
          host: this.imapHost,
          port: this.imapPort,
          username: this.imapUsername
        });
        assertImapMessageIdentity(
          {
            uid,
            uidValidity: expectedUidValidity,
            connectionFingerprint: expectedConnectionFingerprint
          },
          { uidValidity, connectionFingerprint }
        );
        const fetched = await this.fetchMessageByUid(client, uid, true);
        if (!fetched) {
          throw new Error('message not found');
        }

        const parsed = fetched.parsed;
        const providerIdentity = formatImapMessageId(
          uidValidity,
          uid,
          connectionFingerprint
        );
        const rfcMessageId =
          parsed.messageId ?? formatSyntheticImapMessageId(providerIdentity);
        const body = firstTextOrBody(parsed.text, parsed.html);
        return {
          id: providerIdentity,
          accountId,
          provider: 'imap_smtp',
          threadId: buildImapThreadId(
            parsed.inReplyTo,
            parsed.references,
            rfcMessageId
          ),
          messageId: rfcMessageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          from: parsed.from[0] ?? { address: '' },
          to: parsed.to,
          cc: parsed.cc,
          bcc: parsed.bcc,
          subject: parsed.subject,
          date: parsed.date,
          snippet: clampText(body),
          unread: !fetched.flags?.has('\\Seen'),
          text: parsed.text,
          html: parsed.html
        };
      } finally {
        mailboxLock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async getThread(_accountId: string, _threadId: string): Promise<EmailMessage[]> {
    throw new Error('THREADS_NOT_SUPPORTED');
  }

  async createDraft(_input: DraftInput): Promise<{ draftId: string; threadId?: string | null }> {
    throw new Error('DRAFT_NOT_SUPPORTED');
  }

  private static buildStableMessageId(seed: string, domain: string): string {
    const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
    return `<${digest}@${domain}>`;
  }

  private async sendRawPayload(payload: {
    to: EmailAddress[];
    cc?: EmailAddress[];
    bcc?: EmailAddress[];
    subject: string;
    text: string;
    html?: string;
    idempotencyKey?: string;
    inReplyTo?: string | null;
    references?: string[];
  }): Promise<ProviderSendResult> {
    const transport = this.buildSmtpTransport();
    const messageId = GenericImapSmtpProvider.buildStableMessageId(
      `${this.emailAddress}|${payload.idempotencyKey ?? crypto.randomUUID()}|${payload.to.map((entry) => entry.address).join(',')}|${payload.subject}`,
      this.smtpMessageIdDomain || normalizeDomain(this.emailAddress)
    );

    const refs = payload.references?.filter(Boolean).join(' ');
    const headers = [
      `From: ${this.displayName} <${this.emailAddress}>`,
      `To: ${toHeaderList(payload.to).join(', ')}`,
      payload.cc?.length ? `Cc: ${toHeaderList(payload.cc).join(', ')}` : undefined,
      payload.bcc?.length ? `Bcc: ${toHeaderList(payload.bcc).join(', ')}` : undefined,
      `Subject: ${payload.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      payload.inReplyTo ? `In-Reply-To: ${payload.inReplyTo}` : undefined,
      refs ? `References: ${refs}` : undefined,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      payload.idempotencyKey ? `X-Slab-Email-Idempotency-Key: ${payload.idempotencyKey}` : undefined
    ].filter(Boolean).join('\n');

    const body = payload.html ? `${payload.text}\n\n${payload.html}` : payload.text;

    try {
      const info = await transport.sendMail({
        from: `${this.displayName} <${this.emailAddress}>`,
        to: payload.to.map((entry) => entry.address),
        cc: payload.cc?.map((entry) => entry.address),
        bcc: payload.bcc?.map((entry) => entry.address),
        raw: `${headers}\n\n${body}`
      });

      return {
        status: 'sent',
        providerMessageId: GenericImapSmtpProvider.parseMessageId(info),
        providerThreadId: buildImapThreadId(
          payload.inReplyTo,
          payload.references,
          messageId
        )
      };
    } catch (error) {
      if (GenericImapSmtpProvider.isRetryAmbiguous(error)) {
        return {
          status: 'unknown',
          detail: String((error as { message?: string }).message ?? error)
        };
      }
      return {
        status: 'failed',
        detail: String((error as { message?: string }).message ?? error)
      };
    } finally {
      closeSmtpTransport(transport);
    }
  }

  async sendMessage(input: SendInput): Promise<ProviderSendResult> {
    return this.sendRawPayload(input);
  }

  async replyToMessage(input: ReplyInput): Promise<ProviderSendResult> {
    const original = await this.getMessage(this.emailAddress, input.messageId);
    const requestedTo = input.to?.length ? input.to : [original.from];
    const to = input.replyAll ? normalizeAddressList([...(input.to ?? [original.from]), ...original.to, ...(original.cc ?? [])]) : requestedTo;
    const cc = input.replyAll ? normalizeAddressList([...original.to, ...original.cc]) : [];
    const originalMessageId =
      original.messageId ?? formatSyntheticImapMessageId(original.id);
    const refs = buildImapReplyReferences({
      references: original.references,
      inReplyTo: original.inReplyTo,
      messageId: originalMessageId
    });
    const subject = original.subject.toLowerCase().startsWith('re:') ? original.subject : `Re: ${original.subject}`;

    return this.sendRawPayload({
      to,
      cc,
      subject,
      text: input.text,
      html: input.html,
      inReplyTo: originalMessageId,
      references: refs,
      idempotencyKey: input.idempotencyKey
    });
  }

  private static parseMessageId(info: SentMessageInfo): string | undefined {
    if (!info.messageId) return undefined;
    return info.messageId.replace(/^<|>$/g, '');
  }

  private static isRetryAmbiguous(error: unknown): boolean {
    const e = error as { code?: string; responseCode?: number; response?: string };
    const code = String(e?.code ?? '').toLowerCase();
    if (code.includes('etimedout') || code.includes('econnreset') || code.includes('econnaborted') || code.includes('network')) {
      return true;
    }
    return !e.responseCode && !e.response;
  }
}
