import crypto from 'node:crypto';

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export interface EncryptedPayload {
  encryptedPayload: string;
  iv: string;
  authTag: string;
}

export interface EncryptionConfig {
  masterKey: Buffer;
}

export class EncryptionService {
  constructor(private readonly cfg: EncryptionConfig) {
    if (cfg.masterKey.length !== KEY_BYTES) {
      throw new Error('Master key must be 32 bytes');
    }
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.cfg.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      encryptedPayload: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const iv = Buffer.from(payload.iv, 'base64');
    const encrypted = Buffer.from(payload.encryptedPayload, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    if (authTag.length !== TAG_BYTES) {
      throw new Error('Invalid auth tag length');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.cfg.masterKey, iv);
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      throw new Error('Invalid auth tag or corrupted ciphertext');
    }
  }

  static isTamperProof(payload: EncryptedPayload): boolean {
    if (payload.iv.length === 0 || payload.encryptedPayload.length === 0 || payload.authTag.length === 0) {
      return false;
    }
    return true;
  }
}
