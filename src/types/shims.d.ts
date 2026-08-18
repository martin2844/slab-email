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
