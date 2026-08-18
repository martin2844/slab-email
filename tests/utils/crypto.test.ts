import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EncryptionService } from '../../src/utils/crypto.js';

describe('EncryptionService', () => {
  const keyHex = randomBytes(32).toString('hex');
  const service = new EncryptionService({ masterKey: Buffer.from(keyHex, 'hex') });

  it('encrypts and decrypts values deterministically with a valid payload', () => {
    const plaintext = JSON.stringify({ username: 'test', password: 'secret', refreshToken: 'rt-123' });
    const encrypted = service.encrypt(plaintext);
    const roundTrip = service.decrypt(encrypted);

    expect(roundTrip).toBe(plaintext);
    expect(encrypted.encryptedPayload).not.toBe(plaintext);
    expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.authTag, 'base64')).toHaveLength(16);
  });

  it('fails decryption with the wrong master key', () => {
    const plaintext = 'secret text';
    const encrypted = service.encrypt(plaintext);
    const wrongService = new EncryptionService({
      masterKey: randomBytes(32)
    });

    expect(() => {
      wrongService.decrypt(encrypted);
    }).toThrowError(/Invalid auth tag or corrupted ciphertext/);
  });

  it('fails when ciphertext is tampered', () => {
    const plaintext = 'hello';
    const encrypted = service.encrypt(plaintext);
    const tampered = {
      ...encrypted,
      encryptedPayload: `${encrypted.encryptedPayload.slice(0, -1)}A`
    };

    expect(() => {
      service.decrypt(tampered);
    }).toThrow();
  });
});

