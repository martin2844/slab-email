import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  assertImapMessageIdentity,
  formatImapConnectionFingerprint,
  formatImapIdentityEpoch,
  formatImapMessageId,
  guardImapClientErrors,
  paginateImapUids,
  parseImapMessageId
} from '../src/providers/imap-smtp/generic.js';

describe('IMAP durable message identity', () => {
  it('absorbs late IMAP socket errors after a command has already failed', () => {
    const client = guardImapClientErrors(new EventEmitter());

    expect(() => client.emit('error', new Error('Socket timeout'))).not.toThrow();
  });

  it('qualifies UIDs by mailbox UIDVALIDITY', () => {
    expect(formatImapMessageId(41n, 7)).toBe('41:7');
    expect(formatImapMessageId(42n, 7)).toBe('42:7');
    expect(parseImapMessageId('41:7')).toEqual({
      uid: 7,
      uidValidity: '41',
      connectionFingerprint: undefined
    });
  });

  it('scopes UIDVALIDITY to the non-secret mailbox connection identity', () => {
    const first = formatImapIdentityEpoch({
      host: 'imap.one.example',
      port: 993,
      username: 'agent@example.com',
      uidValidity: 1n
    });
    const repointed = formatImapIdentityEpoch({
      host: 'imap.two.example',
      port: 993,
      username: 'agent@example.com',
      uidValidity: 1n
    });

    expect(first).not.toBe(repointed);
    expect(first).not.toContain('agent@example.com');

    const firstFingerprint = formatImapConnectionFingerprint({
      host: 'imap.one.example',
      port: 993,
      username: 'agent@example.com'
    });
    const repointedFingerprint = formatImapConnectionFingerprint({
      host: 'imap.two.example',
      port: 993,
      username: 'agent@example.com'
    });
    const issued = formatImapMessageId(1n, 7, firstFingerprint);
    const parsed = parseImapMessageId(issued);
    expect(parsed.connectionFingerprint).toBe(firstFingerprint);
    expect(parsed.connectionFingerprint).not.toBe(repointedFingerprint);
    expect(() =>
      assertImapMessageIdentity(parsed, {
        uidValidity: '1',
        connectionFingerprint: repointedFingerprint
      })
    ).toThrow('message not found');

    const caseDistinctFingerprint = formatImapConnectionFingerprint({
      host: 'imap.one.example',
      port: 993,
      username: 'Agent@example.com'
    });
    expect(caseDistinctFingerprint).not.toBe(firstFingerprint);
    expect(() =>
      assertImapMessageIdentity(parsed, {
        uidValidity: '1',
        connectionFingerprint: caseDistinctFingerprint
      })
    ).toThrow('message not found');
  });

  it('keeps legacy bare UIDs readable while rejecting malformed identities', () => {
    expect(parseImapMessageId('7')).toEqual({
      uid: 7,
      uidValidity: undefined,
      connectionFingerprint: undefined
    });
    expect(() => parseImapMessageId('mailbox:7')).toThrow('invalid message id');
    expect(() => parseImapMessageId('41:0')).toThrow('invalid message id');
  });

  it('uses a stable UID boundary when the mailbox changes between pages', () => {
    const original = Array.from({ length: 150 }, (_, index) => index + 1);
    const identity = {
      uidValidity: '41',
      connectionFingerprint: '0123456789abcdef01234567'
    };
    const first = paginateImapUids({
      messageIds: original,
      limit: 100,
      ...identity
    });
    expect(first.uids).toEqual(
      Array.from({ length: 100 }, (_, index) => 150 - index)
    );

    const mailboxAfterMutation = original
      .filter((uid) => uid <= 140)
      .concat([151, 152]);
    const second = paginateImapUids({
      messageIds: mailboxAfterMutation,
      cursor: first.nextCursor,
      limit: 100,
      ...identity
    });

    expect(second.uids).toEqual(
      Array.from({ length: 50 }, (_, index) => 50 - index)
    );
    expect(second.nextCursor).toBeUndefined();
    expect([...first.uids, ...second.uids]).toEqual(
      Array.from({ length: 150 }, (_, index) => 150 - index)
    );
    expect(() =>
      paginateImapUids({
        messageIds: mailboxAfterMutation,
        cursor: first.nextCursor,
        limit: 100,
        ...identity,
        uidValidity: '42'
      })
    ).toThrow('IMAP cursor mailbox changed');
  });
});
