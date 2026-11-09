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
        expected: [1, 2, 3, 4, 5, 6, 7],
        applied: [],
        pending: [1, 2, 3, 4, 5, 6, 7]
      });
      database.migrate();
      expect(database.getMigrationStatus()).toEqual({
        ready: true,
        expected: [1, 2, 3, 4, 5, 6, 7],
        applied: [1, 2, 3, 4, 5, 6, 7],
        pending: []
      });
      database.migrate();
      expect(database.getMigrationStatus().applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
      expect(migrated.getMigrationStatus()).toMatchObject({ ready: true, applied: [1, 2, 3, 4, 5, 6, 7] });
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

  it('fails legacy ambiguous send failures closed during upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-send-upgrade-'));
    directories.push(directory);
    const path = join(directory, 'email.db');
    const current = new DatabaseService(path);
    current.close();

    const legacy = new Database(path);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 5;
      INSERT INTO email_accounts (
        id, provider, email_address, display_name, enabled, config_json,
        created_at, updated_at, inbound_generation
      ) VALUES (
        'legacy-account', 'resend', 'ops@example.com', 'Ops', 1, '{}',
        '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 1
      );
      INSERT INTO send_operations (
        account_id, idempotency_key, operation, status, error_code,
        created_at, updated_at
      ) VALUES (
        'legacy-account', 'legacy-ambiguous', 'send', 'failed', 'PROVIDER_ERROR',
        '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'
      );
    `);
    legacy.close();

    const migrated = new DatabaseService(path);
    try {
      expect(migrated.getMigrationStatus()).toMatchObject({
        ready: true,
        applied: [1, 2, 3, 4, 5, 6, 7]
      });
      expect(
        migrated.getAuditForOperation('legacy-account', 'legacy-ambiguous')?.status
      ).toBe('unknown');
    } finally {
      migrated.close();
    }
  });

  it('upgrades a v6 database: suppression table plus send-attempt operation backfill', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-v6-'));
    directories.push(directory);
    const path = join(directory, 'email.db');
    new DatabaseService(path).close();
    const legacy = new Database(path);
    // Rewind the schema to version 6.
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 7;
      DROP TABLE email_suppressions;
      DROP INDEX idx_send_attempts_account_operation_time;
      DROP TABLE send_attempts;
      CREATE TABLE send_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_send_attempts_account_time ON send_attempts(account_id, attempted_at);
      INSERT INTO email_accounts (id, provider, email_address, display_name, enabled, config_json, created_at, updated_at)
        VALUES ('acc', 'resend', 'ops@example.com', 'Ops', 1, '{}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
      INSERT INTO send_operations (account_id, idempotency_key, operation, status, created_at, updated_at) VALUES
        ('acc', 'k1', 'send', 'sent', '2026-11-09T01:00:00.000Z', '2026-11-09T01:00:00.000Z'),
        ('acc', 'k2', 'reply', 'sent', '2026-11-09T02:00:00.000Z', '2026-11-09T02:00:00.000Z');
      INSERT INTO send_attempts (account_id, attempted_at) VALUES
        ('acc', '2026-11-09T01:00:00.000Z'),
        ('acc', '2026-11-09T02:00:00.000Z'),
        ('acc', '2026-11-09T03:00:00.000Z');
    `);
    legacy.close();

    const migrated = new DatabaseService(path);
    try {
      expect(migrated.getMigrationStatus()).toMatchObject({ ready: true, pending: [] });
      expect(migrated.listSendAttemptTimes('acc', 'send', '2026-11-08T00:00:00Z')).toEqual(['2026-11-09T01:00:00.000Z']);
      expect(migrated.listSendAttemptTimes('acc', 'reply', '2026-11-08T00:00:00Z')).toEqual(['2026-11-09T02:00:00.000Z']);
      expect(migrated.countRecentSendAttempts('acc', '2026-11-08T00:00:00Z')).toBe(3);
      expect(migrated.addSuppression({ kind: 'address', value: 'x@example.com', reason: 'stop', source: 'admin' }).created).toBe(true);
    } finally {
      migrated.close();
    }
  });
});
