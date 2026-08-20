import { z } from 'zod';

export const boolFromQuery = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
};

export const parseLimit = (value: unknown, fallback = 20): number => {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 100));
};

const tlsMode = z.union([z.literal('ssl'), z.literal('starttls'), z.literal('none')]);

const emailAddressListSchema = z.array(z.string().trim().toLowerCase().email());

export const createProtonBridgeAccountSchema = z.object({
  emailAddress: z.string().trim().email(),
  displayName: z.string().trim().min(1),
  imapHost: z.string().trim().min(1),
  imapPort: z.coerce.number().int().min(1).max(65535),
  imapTlsMode: tlsMode,
  smtpHost: z.string().trim().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpTlsMode: tlsMode,
  username: z.string().trim().min(1),
  password: z.string().min(1),
  customCA: z.string().trim().min(1).optional(),
  customTls: z.boolean().optional(),
  smtpMessageIdDomain: z.string().trim().min(1).optional()
});

export const createImapSmtpAccountSchema = createProtonBridgeAccountSchema;

export const patchAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).optional(),
    imapHost: z.string().trim().min(1).optional(),
    imapPort: z.coerce.number().int().min(1).max(65535).optional(),
    imapTlsMode: tlsMode.optional(),
    smtpHost: z.string().trim().min(1).optional(),
    smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
    smtpTlsMode: tlsMode.optional(),
    customCA: z.string().trim().min(1).optional(),
    customTls: z.boolean().optional(),
    smtpMessageIdDomain: z.string().trim().min(1).optional(),
    username: z.string().trim().min(1).optional(),
    password: z.string().trim().min(1).optional()
  })
  .superRefine((value, ctx) => {
    const hasAnyUpdate = Object.values(value).some((entry) => entry !== undefined);
    if (!hasAnyUpdate) {
      ctx.addIssue({ code: 'custom', message: 'nothing to update' });
      return;
    }

    if ((value.username !== undefined || value.password !== undefined) && (!value.username || !value.password)) {
      ctx.addIssue({ code: 'custom', message: 'username and password must be updated together' });
    }

    const hasPartialConfig =
      value.imapHost !== undefined ||
      value.imapPort !== undefined ||
      value.imapTlsMode !== undefined ||
      value.smtpHost !== undefined ||
      value.smtpPort !== undefined ||
      value.smtpTlsMode !== undefined;

    if (!hasPartialConfig && (value.customCA !== undefined || value.customTls !== undefined || value.smtpMessageIdDomain !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'custom TLS settings require IMAP/SMTP host+port fields' });
    }

    if (hasPartialConfig && (!value.imapHost || !value.imapPort || !value.imapTlsMode || !value.smtpHost || !value.smtpPort || !value.smtpTlsMode)) {
      ctx.addIssue({ code: 'custom', message: 'imap/smtp host, port and tls mode must be updated together' });
    }
  });

export const accessProfileSchema = z.object({
  name: z.string().trim().min(1),
  readEnabled: z.boolean(),
  draftEnabled: z.boolean(),
  sendEnabled: z.boolean(),
  accountIds: z.array(z.string().trim().min(1))
});

export const gmailConnectSchema = z.object({
  returnUrl: z.string().trim().url().optional()
});

export const googleOauthSettingsSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(4096).optional()
});

export const oauthCallbackSchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1)
});

export const searchParamsSchema = z.object({
  accountId: z.string().trim().min(1),
  query: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  subject: z.string().trim().optional(),
  since: z.string().trim().optional(),
  before: z.string().trim().optional(),
  unread: z.preprocess(boolFromQuery, z.boolean().optional()),
  limit: z.preprocess((value) => parseLimit(value), z.number().optional()),
  cursor: z.string().trim().optional()
});

export const draftSchema = z.object({
  accountId: z.string().trim().min(1),
  to: emailAddressListSchema.min(1),
  cc: emailAddressListSchema.optional(),
  bcc: emailAddressListSchema.optional(),
  subject: z.string().trim().min(1),
  text: z.string().trim().min(1),
  html: z.string().trim().optional()
});

export const idempotentSendSchema = draftSchema.extend({
  idempotencyKey: z.string().trim().min(1)
});

export const replySchema = z.object({
  accountId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  to: emailAddressListSchema.optional(),
  cc: emailAddressListSchema.optional(),
  text: z.string().trim().min(1),
  html: z.string().trim().optional(),
  replyAll: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1)
});
