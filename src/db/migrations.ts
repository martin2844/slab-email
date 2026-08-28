import type Database from 'better-sqlite3';

const nowIso = (): string => new Date().toISOString();
export const EMAIL_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;

function applyBaseSchema(db: Database.Database): void {
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('proton_bridge','imap_smtp','gmail','microsoft_graph','agentmail','resend')),
        email_address TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_connection_status TEXT,
        last_connection_at TEXT
      );

      CREATE TABLE IF NOT EXISTS email_account_secrets (
        account_id TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS access_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        read_enabled INTEGER NOT NULL DEFAULT 1,
        draft_enabled INTEGER NOT NULL DEFAULT 0,
        send_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_profile_accounts (
        profile_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        PRIMARY KEY(profile_id, account_id),
        FOREIGN KEY(profile_id) REFERENCES access_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS access_tokens (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY(profile_id) REFERENCES access_profiles(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS send_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('send','reply')),
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','unknown')),
        provider_message_id TEXT,
        provider_thread_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, idempotency_key),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        code_verifier TEXT NOT NULL,
        meta_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_credentials (
        provider TEXT PRIMARY KEY,
        public_identifier TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_send_operations_lookup ON send_operations(account_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_send_operations_created_at ON send_operations(account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_profile_accounts_account ON access_profile_accounts(account_id);
      CREATE INDEX IF NOT EXISTS idx_access_tokens_profile ON access_tokens(profile_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const recordMigration = db.prepare(
      'INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)'
    );
    recordMigration.run(1, 'initial_email_schema', nowIso());
    recordMigration.run(2, 'provider_credentials', nowIso());
  });
  apply.immediate();
}

function migrateProviderTypes(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get();
  if (applied) return;

  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='email_accounts'")
    .get() as { sql?: string } | undefined;
  const alreadyExpanded = table?.sql?.includes("'microsoft_graph'") === true;

  db.pragma('foreign_keys = OFF');
  try {
    const migration = db.transaction(() => {
      if (!alreadyExpanded) {
        db.exec(`
          CREATE TABLE email_accounts_v3 (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL CHECK(provider IN ('proton_bridge','imap_smtp','gmail','microsoft_graph','agentmail','resend')),
            email_address TEXT NOT NULL,
            display_name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_connection_status TEXT,
            last_connection_at TEXT
          );
          INSERT INTO email_accounts_v3
            SELECT id, provider, email_address, display_name, enabled, config_json,
                   created_at, updated_at, last_connection_status, last_connection_at
            FROM email_accounts;
          DROP TABLE email_accounts;
          ALTER TABLE email_accounts_v3 RENAME TO email_accounts;
        `);
      }
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (3, ?, ?)'
      ).run('extended_email_providers', nowIso());
    });
    migration.immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) throw new Error('provider migration violated foreign keys');
}

function migrateInboundEvents(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get();
  if (applied) return;
  const migration = db.transaction(() => {
    db.exec('ALTER TABLE email_accounts ADD COLUMN inbound_generation INTEGER NOT NULL DEFAULT 1');
    db.exec(`
      CREATE TABLE inbound_seen_messages (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_date TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY(account_id, message_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE inbound_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        UNIQUE(account_id, message_id),
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE inbound_poll_state (
        account_id TEXT PRIMARY KEY,
        initialized_at TEXT,
        last_successful_poll_at TEXT,
        last_error TEXT,
        scan_cursor TEXT,
        scan_started_at TEXT,
        identity_epoch TEXT,
        account_generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_inbound_events_account_id ON inbound_events(account_id, id);
      CREATE INDEX idx_inbound_events_received_at ON inbound_events(received_at);
    `);
    db.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at) VALUES (4, ?, ?)'
    ).run('durable_inbound_events', nowIso());
  });
  migration.immediate();
}

export function runMigrations(db: Database.Database): void {
  applyBaseSchema(db);
  migrateProviderTypes(db);
  migrateInboundEvents(db);
}
