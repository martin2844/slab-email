import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { EmailAddress, OutgoingAttachment } from '../types/models.js';

export interface MimeMessageInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  messageId?: string;
  inReplyTo?: string | null;
  references?: string[] | string;
  headers?: Record<string, string>;
  /**
   * Keep the Bcc header in the generated source. Required by APIs that derive
   * recipients from the raw message (Gmail); never use for SMTP DATA.
   */
  keepBcc?: boolean;
}

const toMailAddress = (entry: EmailAddress) =>
  entry.name ? { name: entry.name, address: entry.address } : entry.address;

/**
 * Builds an RFC 5322 message. With `html` the body is multipart/alternative
 * (text + html); with attachments it is wrapped in multipart/mixed.
 */
export const buildMimeMessage = async (input: MimeMessageInput): Promise<Buffer> => {
  const references = Array.isArray(input.references)
    ? input.references.filter(Boolean).join(' ')
    : input.references;
  const composer = new MailComposer({
    from: toMailAddress(input.from),
    to: input.to.map(toMailAddress),
    cc: input.cc?.length ? input.cc.map(toMailAddress) : undefined,
    bcc: input.bcc?.length ? input.bcc.map(toMailAddress) : undefined,
    subject: input.subject,
    text: input.text,
    html: input.html || undefined,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo || undefined,
    references: references || undefined,
    date: new Date(),
    headers: input.headers,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.contentBase64, 'base64')
    }))
  });
  const node = composer.compile();
  if (input.keepBcc) node.keepBcc = true;
  return node.build();
};
