import { describe, expect, it, vi } from 'vitest';
import { simpleParser } from 'mailparser';

import {
  isTextLikeAttachment,
  readAttachmentContent,
  validateOutgoingAttachments
} from '../src/utils/attachments.js';
import { buildMimeMessage } from '../src/utils/mime.js';
import { ApiError } from '../src/types/errors.js';

const limits = { maxOutgoingAttachments: 10, maxOutgoingAttachmentBytes: 10 * 1024 * 1024 };
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');

const expectInvalid = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('INVALID_INPUT');
    expect((error as ApiError).message).toMatch(pattern);
    return;
  }
  throw new Error('expected INVALID_INPUT');
};

describe('outgoing attachment validation', () => {
  it('normalizes valid attachments and computes decoded sizes', () => {
    expect(validateOutgoingAttachments(undefined, limits)).toBeUndefined();
    expect(validateOutgoingAttachments([], limits)).toBeUndefined();
    const result = validateOutgoingAttachments(
      [{ filename: ' quote.pdf ', contentType: 'Application/PDF', contentBase64: `${b64('hello')}\n` }],
      limits
    );
    expect(result).toEqual([
      { filename: 'quote.pdf', contentType: 'application/pdf', contentBase64: b64('hello'), size: 5 }
    ]);
  });

  it('enforces the configurable count limit', () => {
    const one = { filename: 'a.txt', contentType: 'text/plain', contentBase64: b64('a') };
    expectInvalid(() => validateOutgoingAttachments(Array(11).fill(one), limits), /too many attachments: 11 \(max 10\)/);
    expectInvalid(
      () => validateOutgoingAttachments([one, one], { ...limits, maxOutgoingAttachments: 1 }),
      /max 1/
    );
  });

  it('enforces the configurable total decoded size limit', () => {
    const big = { filename: 'big.bin', contentType: 'application/octet-stream', contentBase64: b64(Buffer.alloc(600)) };
    expect(validateOutgoingAttachments([big], { ...limits, maxOutgoingAttachmentBytes: 600 })).toHaveLength(1);
    expectInvalid(
      () => validateOutgoingAttachments([big, big], { ...limits, maxOutgoingAttachmentBytes: 1000 }),
      /total 1200 bytes exceeds the limit of 1000 bytes/
    );
  });

  it.each(['../etc/passwd', 'dir/file.txt', 'dir\\file.txt', 'bad\u0000name', 'line\r\nbreak.txt', '..', '   ', 'x'.repeat(256)])(
    'rejects unsafe filename %j',
    (filename) => {
      expectInvalid(
        () => validateOutgoingAttachments([{ filename, contentType: 'text/plain', contentBase64: b64('a') }], limits),
        /filename/
      );
    }
  );

  it('rejects invalid content types and base64', () => {
    expectInvalid(
      () => validateOutgoingAttachments([{ filename: 'a.txt', contentType: 'text', contentBase64: b64('a') }], limits),
      /contentType/
    );
    expectInvalid(
      () => validateOutgoingAttachments([{ filename: 'a.txt', contentType: 'text/plain\r\nX-Evil: 1', contentBase64: b64('a') }], limits),
      /contentType/
    );
    expectInvalid(
      () => validateOutgoingAttachments([{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'not base64!' }], limits),
      /contentBase64/
    );
  });
});

describe('attachment content retrieval', () => {
  const readLimits = { maxAttachmentTextBytes: 10, maxAttachmentBase64Bytes: 8 };

  it('classifies text-like types', () => {
    expect(isTextLikeAttachment('text/plain')).toBe(true);
    expect(isTextLikeAttachment('text/csv; charset=utf-8')).toBe(true);
    expect(isTextLikeAttachment('application/json')).toBe(true);
    expect(isTextLikeAttachment('application/vnd.api+json')).toBe(true);
    expect(isTextLikeAttachment('application/xml')).toBe(true);
    expect(isTextLikeAttachment('application/octet-stream', 'export.csv')).toBe(true);
    expect(isTextLikeAttachment('application/pdf')).toBe(false);
    expect(isTextLikeAttachment('image/png')).toBe(false);
  });

  it('returns text truncated to the configured byte limit without splitting characters', async () => {
    const full = await readAttachmentContent(
      { id: '1', filename: 'a.csv', contentType: 'text/csv', load: async () => Buffer.from('a,b\n1,2') },
      readLimits
    );
    expect(full).toEqual({ id: '1', filename: 'a.csv', contentType: 'text/csv', size: 7, encoding: 'text', content: 'a,b\n1,2', truncated: false });

    // "ñ" is two bytes; a 10-byte cut would split the 5th "ñ".
    const truncated = await readAttachmentContent(
      { id: '2', filename: 'n.txt', contentType: 'text/plain', size: 1_000_000, load: async () => Buffer.from('ñ'.repeat(20)) },
      readLimits
    );
    expect(truncated).toMatchObject({ encoding: 'text', content: 'ñ'.repeat(5), truncated: true, size: 40 });
  });

  it('returns binary content as base64 under the limit', async () => {
    const result = await readAttachmentContent(
      { id: '3', filename: 'p.png', contentType: 'image/png', size: 4, load: async () => Buffer.from([1, 2, 3, 4]) },
      readLimits
    );
    expect(result).toMatchObject({ encoding: 'base64', content: Buffer.from([1, 2, 3, 4]).toString('base64'), truncated: false });
  });

  it('refuses oversized binaries before downloading when the size is known', async () => {
    const load = vi.fn(async () => Buffer.alloc(9));
    await expect(
      readAttachmentContent({ id: '4', filename: 'big.pdf', contentType: 'application/pdf', size: 9, load }, readLimits)
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', status: 413, message: expect.stringMatching(/too large/) });
    expect(load).not.toHaveBeenCalled();

    // Unknown declared size: checked after download.
    await expect(
      readAttachmentContent({ id: '5', filename: 'big.pdf', contentType: 'application/pdf', load }, readLimits)
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });
});

describe('MIME message building', () => {
  it('sends multipart/alternative when html is given', async () => {
    const raw = await buildMimeMessage({
      from: { name: 'Sales', address: 'sales@example.com' },
      to: [{ address: 'lead@example.com' }],
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>'
    });
    const source = raw.toString('utf8');
    expect(source).toMatch(/Content-Type: multipart\/alternative/);
    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe('Plain body');
    expect(parsed.html).toContain('<p>HTML body</p>');
  });

  it('keeps a single text/plain part without html', async () => {
    const raw = await buildMimeMessage({
      from: { address: 'sales@example.com' },
      to: [{ address: 'lead@example.com' }],
      subject: 'Hello',
      text: 'Plain body'
    });
    expect(raw.toString('utf8')).toMatch(/Content-Type: text\/plain/);
    expect(raw.toString('utf8')).not.toMatch(/multipart/);
  });

  it('adds attachments, threading headers, and omits Bcc unless asked', async () => {
    const input = {
      from: { address: 'sales@example.com' },
      to: [{ address: 'lead@example.com' }],
      bcc: [{ address: 'hidden@example.com' }],
      subject: 'Re: Quote',
      text: 'See attached',
      html: '<p>See attached</p>',
      attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', contentBase64: b64('%PDF-1.4'), size: 8 }],
      messageId: '<id-1@example.com>',
      inReplyTo: '<root@example.com>',
      references: ['<root@example.com>'],
      headers: { 'X-Slab-Email-Idempotency-Key': 'key-1' }
    };
    const raw = await buildMimeMessage(input);
    const source = raw.toString('utf8');
    expect(source).toMatch(/Content-Type: multipart\/mixed/);
    expect(source).toMatch(/Content-Type: multipart\/alternative/);
    expect(source).not.toMatch(/^Bcc:/m);
    expect(source).toMatch(/^X-Slab-Email-Idempotency-Key: key-1/m);
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toBe('<id-1@example.com>');
    expect(parsed.inReplyTo).toBe('<root@example.com>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments?.[0]).toMatchObject({ filename: 'quote.pdf', contentType: 'application/pdf' });
    expect(parsed.attachments?.[0]?.content.toString()).toBe('%PDF-1.4');

    const withBcc = (await buildMimeMessage({ ...input, keepBcc: true })).toString('utf8');
    expect(withBcc).toMatch(/^Bcc: hidden@example.com/m);
  });
});
