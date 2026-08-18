import { htmlToText } from 'html-to-text';

export interface ParsedMailEnvelope {
  messageId?: string;
  inReplyTo?: string | null;
  references?: string[];
  subject: string;
  date: Date | string;
  from?: { name?: string; address?: string };
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  bcc?: { name?: string; address?: string }[];
  text?: string;
  html?: string;
}

export interface EmailAddressInput {
  name?: string;
  address?: string;
}

export const normalizeAddressValue = (value?: string): string => {
  if (!value) return '';
  return value.trim().toLowerCase().replace(/\r?\n/g, '');
};

export const normalizeAddressList = (value?: EmailAddressInput[]): { name?: string; address: string }[] =>
  (value ?? [])
    .map((entry) => ({
      name: entry.name,
      address: normalizeAddressValue(entry.address)
    }))
    .filter((entry): entry is { name: string | undefined; address: string } => Boolean(entry.address));

export const firstTextOrBody = (text?: string, html?: string): string => {
  if (text && text.trim()) return text.trim();
  if (!html) return '';
  return htmlToText(html, { wordwrap: false }).trim();
};

export const clampText = (value: string, max = 320): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
};
