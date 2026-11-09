declare module 'mailparser' {
  export interface ParsedMail {
    subject?: string;
    text?: string;
    html?: string;
    date?: Date | string | null;
    inReplyTo?: string | null;
    references?: string[];
    messageId?: string;
    from?: { value?: Array<{ name?: string; address?: string }> };
    to?: { value?: Array<{ name?: string; address?: string }> };
    cc?: { value?: Array<{ name?: string; address?: string }> };
    bcc?: { value?: Array<{ name?: string; address?: string }> };
    attachments?: Attachment[];
  }

  export interface Attachment {
    filename?: string;
    contentType?: string;
    contentDisposition?: string;
    size?: number;
    content: Buffer;
    related?: boolean;
    cid?: string;
  }

  export function simpleParser(input: Buffer | string): Promise<ParsedMail>;
}

declare module 'nodemailer' {
  export interface SentMessageInfo {
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    response?: string;
  }

  export interface Transporter {
    sendMail(message: unknown): Promise<SentMessageInfo>;
    verify(): Promise<void>;
  }

  interface NodemailerFactory {
    createTransport(options: unknown): Transporter;
  }

  const nodemailer: NodemailerFactory;
  export default nodemailer;
}

declare module 'html-to-text' {
  export function htmlToText(html: string, options?: Record<string, unknown>): string;
}

declare module 'nodemailer/lib/mail-composer/index.js' {
  interface MailComposerAddress {
    name?: string;
    address: string;
  }

  interface MailComposerOptions {
    from?: string | MailComposerAddress;
    to?: Array<string | MailComposerAddress>;
    cc?: Array<string | MailComposerAddress>;
    bcc?: Array<string | MailComposerAddress>;
    subject?: string;
    text?: string;
    html?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string;
    date?: Date;
    headers?: Record<string, string>;
    attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
  }

  interface MimeNode {
    keepBcc: boolean;
    build(): Promise<Buffer>;
  }

  export default class MailComposer {
    constructor(options: MailComposerOptions);
    compile(): MimeNode;
  }
}
