import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { DatabaseService } from '../src/db/database.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('database lifecycle', () => {
  it('supports one-shot migrations and readiness without mutating on server open', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-db-'));
    directories.push(directory);
    const database = new DatabaseService(join(directory, 'email.db'), { migrate: false });
    try {
      expect(database.getMigrationStatus()).toEqual({
        ready: false,
        expected: [1, 2, 3, 4],
        applied: [],
        pending: [1, 2, 3, 4]
      });
      database.migrate();
      expect(database.getMigrationStatus()).toEqual({
        ready: true,
        expected: [1, 2, 3, 4],
        applied: [1, 2, 3, 4],
        pending: []
      });
      database.migrate();
      expect(database.getMigrationStatus().applied).toEqual([1, 2, 3, 4]);
    } finally {
      database.close();
    }
  });

  it('migrates existing account rows to the extended provider contract', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-legacy-'));
    directories.push(directory);
    const path = join(directory, 'email.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE email_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('proton_bridge','imap_smtp','gmail')),
        email_address TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_connection_status TEXT,
        last_connection_at TEXT
      );
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_email_schema', '2026-08-20T00:00:00Z');
      INSERT INTO schema_migrations VALUES (2, 'provider_credentials', '2026-08-20T00:00:00Z');
      INSERT INTO email_accounts VALUES ('legacy', 'gmail', 'legacy@example.com', 'Legacy', 1, '{"emailAddress":"legacy@example.com","displayName":"Legacy"}', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL, NULL);
    `);
    legacy.close();

    const migrated = new DatabaseService(path);
    try {
      expect(migrated.getEmailAccountById('legacy')?.provider).toBe('gmail');
      expect(migrated.getMigrationStatus()).toMatchObject({ ready: true, applied: [1, 2, 3, 4] });
      migrated.upsertEmailAccount({
        id: 'agentmail', provider: 'agentmail', emailAddress: 'agent@agentmail.to',
        displayName: 'Agent', enabled: true,
        config: { emailAddress: 'agent@agentmail.to', displayName: 'Agent', inboxId: 'agent@agentmail.to', baseUrl: 'https://api.agentmail.to/v0' },
      });
      expect(migrated.getEmailAccountById('agentmail')?.provider).toBe('agentmail');
    } finally {
      migrated.close();
    }
  });
});
