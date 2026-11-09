import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleParser } from 'mailparser';

import { AgentMailProvider } from '../src/providers/agentmail/provider.js';
import { MicrosoftGraphProvider } from '../src/providers/microsoft-graph/provider.js';
import { ResendProvider } from '../src/providers/resend/provider.js';
import { collectGmailAttachmentParts, gmailMessageUpload } from '../src/providers/gmail/provider.js';
import { buildMimeMessage } from '../src/utils/mime.js';

const imapState = vi.hoisted(() => ({ source: Buffer.alloc(0) }));
const smtpState = vi.hoisted(() => ({ sent: [] as Array<{ envelope: { from: string; to: string[] }; raw: Buffer }> }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidValidity: 7n };
    on() { return this; }
    async connect() {}
    async logout() {}
    async getMailboxLock() { return { release() {} }; }
    async fetchOne() { return { source: imapState.source, flags: new Set<string>() }; }
  }
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: { envelope: { from: string; to: string[] }; raw: Buffer }) => {
        smtpState.sent.push(message);
        return { messageId: '<sent@example.com>' };
      },
      verify: async () => undefined,
      close: () => undefined
    })
  }
}));

const json = (body: unknown, status = 200) =>
  new Response(status === 204 || status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
const bytes = (data: Buffer | string, contentType = 'application/octet-stream') =>
  new Response(Buffer.from(data), { status: 200, headers: { 'Content-Type': contentType } });
const pdf = { filename: 'quote.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF').toString('base64'), size: 4 };

afterEach(() => {
  vi.unstubAllGlobals();
  smtpState.sent = [];
});

describe('IMAP/SMTP and Proton Bridge', () => {
  const makeProvider = async () => {
    const { GenericImapSmtpProvider } = await import('../src/providers/imap-smtp/generic.js');
    return new GenericImapSmtpProvider({
      emailAddress: 'sales@example.com',
      displayName: 'Sales Team',
      imap: { imapHost: '127.0.0.1', imapPort: 1143, imapTlsMode: 'none', username: 'u', password: 'p' },
      smtp: { smtpHost: '127.0.0.1', smtpPort: 1025, smtpTlsMode: 'none', fromAddress: 'sales@example.com', username: 'u', password: 'p' }
    });
  };

  it('sends multipart/alternative with attachments and keeps Bcc out of the message', async () => {
    const provider = await makeProvider();
    const result = await provider.sendMessage({
      accountId: 'a1',
      to: [{ address: 'lead@example.com' }],
      bcc: [{ address: 'hidden@example.com' }],
      subject: 'Quote',
      text: 'Plain',
      html: '<p>Rich</p>',
      attachments: [pdf],
      idempotencyKey: 'smtp-1'
    });
    expect(result.status).toBe('sent');
    const [message] = smtpState.sent;
    expect(message!.envelope).toEqual({ from: 'sales@example.com', to: ['lead@example.com', 'hidden@example.com'] });
    const source = message!.raw.toString('utf8');
    expect(source).not.toMatch(/^Bcc:/m);
    expect(source).toMatch(/^X-Slab-Email-Idempotency-Key: smtp-1/m);
    const parsed = await simpleParser(message!.raw);
    expect(parsed.text?.trim()).toBe('Plain');
    expect(parsed.html).toContain('<p>Rich</p>');
    expect(parsed.attachments?.[0]).toMatchObject({ filename: 'quote.pdf', contentType: 'application/pdf' });
  });

  it('keeps plain-text-only sends as text/plain', async () => {
    const provider = await makeProvider();
    await provider.sendMessage({ accountId: 'a1', to: [{ address: 'x@example.com' }], subject: 'S', text: 'Only text', idempotencyKey: 'smtp-2' });
    const source = smtpState.sent[0]!.raw.toString('utf8');
    expect(source).toMatch(/Content-Type: text\/plain/);
    expect(source).not.toMatch(/multipart/);
  });

  it('lists attachment metadata and downloads by id', async () => {
    imapState.source = await buildMimeMessage({
      from: { address: 'lead@example.com' },
      to: [{ address: 'sales@example.com' }],
      subject: 'Files',
      text: 'see attached',
      attachments: [
        { filename: 'data.csv', contentType: 'text/csv', contentBase64: Buffer.from('a,b').toString('base64'), size: 3 },
        pdf
      ]
    });
    const provider = await makeProvider();
    const message = await provider.getMessage('a1', '7:42');
    expect(message.attachments).toEqual([
      { id: '0', filename: 'data.csv', contentType: 'text/csv', size: 3, inline: false },
      { id: '1', filename: 'quote.pdf', contentType: 'application/pdf', size: 4, inline: false }
    ]);
    const handle = await provider.getAttachment('a1', '7:42', '1');
    expect((await handle.load()).toString()).toBe('%PDF');
    await expect(provider.getAttachment('a1', '7:42', '9')).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });
});

describe('Gmail', () => {
  it('collects attachment parts by partId', () => {
    const parts = collectGmailAttachmentParts({
      partId: '',
      mimeType: 'multipart/mixed',
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: 'aGk' } },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'quote.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="quote.pdf"' }],
          body: { attachmentId: 'ANGjdJ', size: 1234 }
        },
        {
          partId: '2',
          mimeType: 'image/png',
          filename: 'logo.png',
          headers: [{ name: 'Content-Disposition', value: 'inline' }],
          body: { attachmentId: 'XYZ', size: 10 }
        }
      ]
    });
    expect(parts.map(({ metadata }) => metadata)).toEqual([
      { id: '1', filename: 'quote.pdf', contentType: 'application/pdf', size: 1234, inline: false },
      { id: '2', filename: 'logo.png', contentType: 'image/png', size: 10, inline: true }
    ]);
  });

  it('uses JSON raw for small messages and RFC 822 media upload for large ones', () => {
    const small = gmailMessageUpload(Buffer.from('From: a\r\n\r\nhi'), 'thread-1');
    expect(small).toMatchObject({ threadId: 'thread-1', raw: expect.any(String) });
    expect(small.media).toBeUndefined();
    const large = gmailMessageUpload(Buffer.alloc(4 * 1024 * 1024), 'thread-1');
    expect(large.raw).toBeUndefined();
    expect(large.media?.mimeType).toBe('message/rfc822');
  });
});

describe('Microsoft Graph', () => {
  const makeProvider = () =>
    new MicrosoftGraphProvider({ emailAddress: 'sales@example.com', displayName: 'Sales', refreshToken: 'r', clientId: 'c', clientSecret: 's', tenant: 'common' });

  it('sends html bodies with inline file attachments and lists/downloads attachments', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/attachments/att%3D1/$value')) return bytes('%PDF');
      if (url.includes('/attachments/att%3D1?')) return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'att=1', name: 'quote.pdf', contentType: 'application/pdf', size: 4 });
      if (url.includes('/attachments/item1?')) return json({ '@odata.type': '#microsoft.graph.itemAttachment', id: 'item1', name: 'Fwd', size: 10 });
      if (url.includes('/me/messages/g1/attachments?')) return json({ value: [{ id: 'att=1', name: 'quote.pdf', contentType: 'application/pdf', size: 4, isInline: false }] });
      if (url.includes('/me/messages/g1?')) return json({ id: 'g1', hasAttachments: true, from: { emailAddress: { address: 'lead@example.com' } }, subject: 'Q', body: { contentType: 'text', content: 'x' } });
      return json(undefined, 202);
    }));
    const provider = makeProvider();
    await provider.sendMessage({ accountId: 'a', to: [{ address: 'lead@example.com' }], subject: 'Hi', text: 'Plain', html: '<p>Rich</p>', attachments: [pdf], idempotencyKey: 'g-1' });
    const sendBody = JSON.parse(String(calls.find(({ url }) => url.endsWith('/me/sendMail'))!.init!.body));
    expect(sendBody.message.body).toEqual({ contentType: 'HTML', content: '<p>Rich</p>' });
    expect(sendBody.message.attachments).toEqual([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'quote.pdf', contentType: 'application/pdf', contentBytes: pdf.contentBase64 }
    ]);

    const message = await provider.getMessage('a', 'g1');
    expect(message.attachments).toEqual([{ id: 'att=1', filename: 'quote.pdf', contentType: 'application/pdf', size: 4, inline: false }]);
    const handle = await provider.getAttachment('a', 'g1', 'att=1');
    expect(handle.size).toBe(4);
    expect((await handle.load()).toString()).toBe('%PDF');
    await expect(provider.getAttachment('a', 'g1', 'item1')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('replies with html via message.body and attachments, and keeps comment for plain replies', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 't', expires_in: 3600 });
      return json(undefined, 202);
    }));
    const provider = makeProvider();
    await provider.replyToMessage({ accountId: 'a', messageId: 'm1', text: 'Plain', idempotencyKey: 'r0' });
    await provider.replyToMessage({ accountId: 'a', messageId: 'm1', text: 'Plain', html: '<p>Rich</p>', attachments: [pdf], idempotencyKey: 'r1' });
    const bodies = calls.filter(({ url }) => url.endsWith('/me/messages/m1/reply')).map(({ init }) => JSON.parse(String(init!.body)));
    expect(bodies[0]).toEqual({ comment: 'Plain' });
    expect(bodies[1]).toEqual({
      message: {
        body: { contentType: 'HTML', content: '<p>Rich</p>' },
        attachments: [expect.objectContaining({ name: 'quote.pdf', contentBytes: pdf.contentBase64 })]
      }
    });
  });

  it('uses a draft with an upload session for large attachments', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 't', expires_in: 3600 });
      if (url.endsWith('/me/messages') && init?.method === 'POST') return json({ id: 'draft-1' });
      if (url.endsWith('/attachments/createUploadSession')) return json({ uploadUrl: 'https://upload.example/session' });
      if (url === 'https://upload.example/session') return json({}, 200);
      return json(undefined, 202);
    }));
    const large = Buffer.alloc(5 * 1024 * 1024, 1);
    const result = await makeProvider().sendMessage({
      accountId: 'a',
      to: [{ address: 'lead@example.com' }],
      subject: 'Big',
      text: 'see attached',
      attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', contentBase64: large.toString('base64'), size: large.length }],
      idempotencyKey: 'big-1'
    });
    expect(result.status).toBe('sent');
    const draftBody = JSON.parse(String(calls.find(({ url, init }) => url.endsWith('/me/messages') && init?.method === 'POST')!.init!.body));
    expect(draftBody.attachments).toBeUndefined();
    expect(draftBody.internetMessageHeaders).toEqual([{ name: 'X-Slab-Email-Idempotency-Key', value: 'big-1' }]);
    const uploads = calls.filter(({ url }) => url === 'https://upload.example/session');
    expect(uploads.length).toBe(2);
    expect(new Headers(uploads[0]!.init!.headers).get('Authorization')).toBeNull();
    expect(new Headers(uploads[1]!.init!.headers).get('Content-Range')).toBe(`bytes 3932160-${large.length - 1}/${large.length}`);
    expect(calls.at(-1)!.url).toMatch(/\/me\/messages\/draft-1\/send$/);
    expect(calls.some(({ url }) => url.endsWith('/me/sendMail'))).toBe(false);
  });

  it('reports a definite failure and cleans up the draft when an upload fails before sending', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 't', expires_in: 3600 });
      if (url.endsWith('/me/messages') && init?.method === 'POST') return json({ id: 'draft-2' });
      if (url.endsWith('/attachments/createUploadSession')) return json({ error: { message: 'quota' } }, 403);
      return json(undefined, 204);
    }));
    const large = Buffer.alloc(4 * 1024 * 1024, 1);
    const result = await makeProvider().sendMessage({
      accountId: 'a', to: [{ address: 'lead@example.com' }], subject: 'Big', text: 'x',
      attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', contentBase64: large.toString('base64'), size: large.length }],
      idempotencyKey: 'big-2'
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(calls.some(({ url, init }) => url.endsWith('/me/messages/draft-2') && init?.method === 'DELETE')).toBe(true);
    expect(calls.some(({ url }) => url.endsWith('/send'))).toBe(false);
  });
});

describe('Resend', () => {
  it('sends html and attachments and downloads received attachments via signed URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/emails')) return json({ id: 'sent-1' });
      if (url.endsWith('/emails/receiving/r1/attachments/att1')) return json({ id: 'att1', filename: 'a.csv', content_type: 'text/csv', size: 3, download_url: 'https://cdn.resend.example/a.csv?sig=1' });
      if (url.endsWith('/emails/receiving/r1/attachments/missing')) return json({ message: 'not found' }, 404);
      if (url.endsWith('/emails/receiving/r1')) return json({ id: 'r1', from: 'lead@example.com', to: ['sales@example.com'], subject: 'Q', created_at: '2026-11-09T00:00:00Z', attachments: [{ id: 'att1', filename: 'a.csv', content_type: 'text/csv', size: 3, content_disposition: 'attachment' }] });
      if (url.startsWith('https://cdn.resend.example/')) return bytes('a,b', 'text/csv');
      return json({});
    }));
    const provider = new ResendProvider({ emailAddress: 'sales@example.com', displayName: 'Sales', apiKey: 're_key', baseUrl: 'https://api.resend.com', inboundEnabled: true });
    await provider.sendMessage({ accountId: 'a', to: [{ address: 'lead@example.com' }], subject: 'Hi', text: 'Plain', html: '<p>Rich</p>', attachments: [pdf], idempotencyKey: 're-1' });
    const body = JSON.parse(String(calls.find(({ url }) => url.endsWith('/emails'))!.init!.body));
    expect(body).toMatchObject({ text: 'Plain', html: '<p>Rich</p>', attachments: [{ filename: 'quote.pdf', content: pdf.contentBase64, content_type: 'application/pdf' }] });

    const message = await provider.getMessage('a', 'r1');
    expect(message.attachments).toEqual([{ id: 'att1', filename: 'a.csv', contentType: 'text/csv', size: 3, inline: false }]);
    const handle = await provider.getAttachment('a', 'r1', 'att1');
    expect((await handle.load()).toString()).toBe('a,b');
    const download = calls.find(({ url }) => url.startsWith('https://cdn.resend.example/'))!;
    expect(new Headers(download.init?.headers).get('Authorization')).toBeNull();
    await expect(provider.getAttachment('a', 'r1', 'missing')).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });
});

describe('AgentMail', () => {
  it('sends html and attachments on send, reply and draft, and downloads attachments', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/messages/send')) return json({ message_id: 's1', thread_id: 't1' });
      if (url.endsWith('/messages/m1/reply')) return json({ message_id: 'r1', thread_id: 't1' });
      if (url.endsWith('/drafts')) return json({ draft_id: 'd1' });
      if (url.endsWith('/messages/m1/attachments/a1')) return json({ attachment_id: 'a1', download_url: 'https://files.agentmail.example/a1' });
      if (url.endsWith('/messages/m1/attachments/a2')) return bytes('%PDF', 'application/pdf');
      if (url.endsWith('/messages/m1')) {
        return json({
          message_id: 'm1', from: 'lead@example.com', to: ['sales@agentmail.to'], subject: 'Files',
          attachments: [
            { attachment_id: 'a1', filename: 'notes.txt', content_type: 'text/plain', size: 5 },
            { attachment_id: 'a2', filename: 'quote.pdf', content_type: 'application/pdf', size: 4, inline: false }
          ]
        });
      }
      if (url === 'https://files.agentmail.example/a1') return bytes('hello', 'text/plain');
      return json({});
    }));
    const provider = new AgentMailProvider({ emailAddress: 'sales@agentmail.to', displayName: 'Sales', inboxId: 'sales@agentmail.to', apiKey: 'k', baseUrl: 'https://api.agentmail.to/v0' });
    await provider.sendMessage({ accountId: 'a', to: [{ address: 'lead@example.com' }], subject: 'Hi', text: 'Plain', html: '<p>Rich</p>', attachments: [pdf], idempotencyKey: 'am-1' });
    await provider.replyToMessage({ accountId: 'a', messageId: 'm1', text: 'Plain', html: '<p>Rich</p>', attachments: [pdf], idempotencyKey: 'am-2' });
    await provider.createDraft({ accountId: 'a', to: [{ address: 'lead@example.com' }], subject: 'D', text: 'Plain', attachments: [pdf] });
    for (const suffix of ['/messages/send', '/messages/m1/reply', '/drafts']) {
      const body = JSON.parse(String(calls.find(({ url }) => url.endsWith(suffix))!.init!.body));
      expect(body.attachments).toEqual([{ filename: 'quote.pdf', content_type: 'application/pdf', content: pdf.contentBase64 }]);
    }
    expect(JSON.parse(String(calls.find(({ url }) => url.endsWith('/messages/send'))!.init!.body)).html).toBe('<p>Rich</p>');

    const message = await provider.getMessage('a', 'm1');
    expect(message.attachments).toEqual([
      { id: 'a1', filename: 'notes.txt', contentType: 'text/plain', size: 5, inline: false },
      { id: 'a2', filename: 'quote.pdf', contentType: 'application/pdf', size: 4, inline: false }
    ]);
    expect((await (await provider.getAttachment('a', 'm1', 'a1')).load()).toString()).toBe('hello');
    expect((await (await provider.getAttachment('a', 'm1', 'a2')).load()).toString()).toBe('%PDF');
    await expect(provider.getAttachment('a', 'm1', 'zzz')).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });
});
