import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env.js';

const masterKey = 'a'.repeat(64);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('runtime config', () => {
  it('reads required secrets from mounted files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-secret-'));
    directories.push(directory);
    const adminPath = join(directory, 'admin-key');
    const masterPath = join(directory, 'master-key');
    writeFileSync(adminPath, 'file-admin-key\n', { mode: 0o600 });
    writeFileSync(masterPath, `${masterKey}\n`, { mode: 0o600 });

    const config = loadConfig({
      SLAB_EMAIL_ADMIN_KEY_FILE: adminPath,
      SLAB_EMAIL_MASTER_KEY_FILE: masterPath,
      SKIP_MIGRATIONS: 'true'
    });
    expect(config.adminKey).toBe('file-admin-key');
    expect(config.masterKey).toEqual(Buffer.from(masterKey, 'hex'));
    expect(config.skipMigrations).toBe(true);
    expect(config.inboundPollIntervalMs).toBe(30_000);
  });

  it('rejects ambiguous or unreadable secret sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-secret-'));
    directories.push(directory);
    const adminPath = join(directory, 'admin-key');
    writeFileSync(adminPath, 'file-admin-key\n', { mode: 0o600 });

    expect(() =>
      loadConfig({
        SLAB_EMAIL_ADMIN_KEY: 'direct-admin-key',
        SLAB_EMAIL_ADMIN_KEY_FILE: adminPath,
        SLAB_EMAIL_MASTER_KEY: masterKey
      })
    ).toThrow(/only one/);
    expect(() =>
      loadConfig({
        SLAB_EMAIL_ADMIN_KEY_FILE: join(directory, 'missing'),
        SLAB_EMAIL_MASTER_KEY: masterKey
      })
    ).toThrow('SLAB_EMAIL_ADMIN_KEY_FILE could not be read');
  });

  it('supports disabling the inbound poller', () => {
    const config = loadConfig({
      SLAB_EMAIL_ADMIN_KEY: 'direct-admin-key',
      SLAB_EMAIL_MASTER_KEY: masterKey,
      INBOUND_POLL_INTERVAL_SECONDS: '0'
    });

    expect(config.inboundPollIntervalMs).toBe(0);
  });
});
