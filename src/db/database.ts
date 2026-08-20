import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import {
  AccessProfile,
  AccessProfileWithAccounts,
  AccountRecord,
  EmailAccountConfig,
  OAuthMetaState,
  OAuthState,
  ProviderType,
  ScopedAuthContext,
  SendOperationRecord
} from '../types/models.js';

const nowIso = (): string => new Date().toISOString();

type ProviderCapabilities = {
  read: boolean;
  search: boolean;
  draft: boolean;
  send: boolean;
  reply: boolean;
  threads: boolean;
};

const capabilityMap: Record<ProviderType, ProviderCapabilities> = {
  gmail: {
    read: true,
    search: true,
    draft: true,
    send: true,
    reply: true,
    threads: true
  },
  proton_bridge: {
    read: true,
    search: true,
    draft: false,
    send: true,
    reply: true,
    threads: false
  },
  imap_smtp: {
    read: true,
    search: true,
    draft: false,
    send: true,
    reply: true,
    threads: false
  }
};

interface EmailAccountRow {
  id: string;
  provider: ProviderType;
  email_address: string;
  display_name: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
  last_connection_status: string | null;
  last_connection_at: string | null;
}

interface OAuthStateRow {
  state: string;
  provider: string;
  requested_at: number;
  expires_at: number;
  code_verifier: string;
  meta_json: string;
}

interface ProviderCredentialRow {
  provider: string;
  public_identifier: string;
  encrypted_payload: string;
  iv: string;
  auth_tag: string;
  updated_at: string;
}

interface SendOperationRow {
  id: number;
  account_id: string;
  idempotency_key: string;
  operation: 'send' | 'reply';
  status: 'pending' | 'sent' | 'failed' | 'unknown';
  provider_message_id: string | null;
  provider_thread_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export class DatabaseService {
  private readonly db: Database.Database;

  constructor(databasePath: string, options: { migrate?: boolean } = {}) {
    const resolved = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    if (options.migrate !== false) this.migrate();
  }

  migrate(): void {
    const apply = this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_accounts (
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
    `);

      this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_send_operations_lookup ON send_operations(account_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_send_operations_created_at ON send_operations(account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_profile_accounts_account ON access_profile_accounts(account_id);
      CREATE INDEX IF NOT EXISTS idx_access_tokens_profile ON access_tokens(profile_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      this.db.prepare(
        'INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)'
      ).run('initial_email_schema', nowIso());
      this.db.prepare(
        'INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (2, ?, ?)'
      ).run('provider_credentials', nowIso());
    });
    apply.immediate();
  }

  getMigrationStatus(): { ready: boolean; expected: number[]; applied: number[]; pending: number[] } {
    const table = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get();
    const applied = table
      ? (this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
          version: number;
        }>).map(({ version }) => version)
      : [];
    const expected = [1, 2];
    const pending = expected.filter((version) => !applied.includes(version));
    return { ready: pending.length === 0, expected, applied, pending };
  }

  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  getEmailAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, provider, email_address, display_name, enabled, config_json, created_at, updated_at, last_connection_status, last_connection_at
        FROM email_accounts
        ORDER BY created_at DESC
        `
      )
      .all() as EmailAccountRow[];

    return rows.map((row) => this.mapAccount(row));
  }

  getEmailAccountById(accountId: string): AccountRecord | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, provider, email_address, display_name, enabled, config_json, created_at, updated_at, last_connection_status, last_connection_at
        FROM email_accounts
        WHERE id = ?
        `
      )
      .get(accountId) as EmailAccountRow | undefined;

    return row ? this.mapAccount(row) : undefined;
  }

  upsertEmailAccount(data: {
    id: string;
    provider: ProviderType;
    emailAddress: string;
    displayName: string;
    enabled: boolean;
    config: EmailAccountConfig;
    connectionStatus?: string | null;
    connectionAt?: string | null;
  }): void {
    const existing = this.getEmailAccountById(data.id);
    const now = nowIso();

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE email_accounts
          SET provider=@provider,
              email_address=@emailAddress,
              display_name=@displayName,
              enabled=@enabled,
              config_json=@configJson,
              updated_at=@updatedAt,
              last_connection_status=@status,
              last_connection_at=@at
          WHERE id=@id
          `
        )
        .run({
          id: data.id,
          provider: data.provider,
          emailAddress: data.emailAddress,
          displayName: data.displayName,
          enabled: data.enabled ? 1 : 0,
          configJson: JSON.stringify(data.config),
          updatedAt: now,
          status: data.connectionStatus ?? null,
          at: data.connectionAt ?? null
        });
      return;
    }

    this.db
      .prepare(
        `
        INSERT INTO email_accounts (
          id,
          provider,
          email_address,
          display_name,
          enabled,
          config_json,
          created_at,
          updated_at,
          last_connection_status,
          last_connection_at
        )
        VALUES (
          @id,
          @provider,
          @emailAddress,
          @displayName,
          @enabled,
          @configJson,
          @createdAt,
          @updatedAt,
          @status,
          @at
        )
        `
      )
      .run({
        id: data.id,
        provider: data.provider,
        emailAddress: data.emailAddress,
        displayName: data.displayName,
        enabled: data.enabled ? 1 : 0,
        configJson: JSON.stringify(data.config),
        createdAt: now,
        updatedAt: now,
        status: data.connectionStatus ?? null,
        at: data.connectionAt ?? null
      });
  }

  removeEmailAccount(id: string): void {
    this.db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
  }

  setAccountEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE email_accounts SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), id);
  }

  updateAccountConnectionStatus(accountId: string, status: string, connectedAt?: string): void {
    this.db
      .prepare(
        `
        UPDATE email_accounts
        SET last_connection_status = @status,
            last_connection_at = @at,
            updated_at = @updatedAt
        WHERE id = @id
        `
      )
      .run({
        id: accountId,
        status,
        at: connectedAt ?? nowIso(),
        updatedAt: nowIso()
      });
  }

  setEmailAccountSecret(accountId: string, encryptedPayload: string, iv: string, authTag: string): void {
    this.db
      .prepare(
        `
        INSERT INTO email_account_secrets (account_id, encrypted_payload, iv, auth_tag, updated_at)
        VALUES (@accountId, @encryptedPayload, @iv, @authTag, @updatedAt)
        ON CONFLICT(account_id) DO UPDATE SET
          encrypted_payload = excluded.encrypted_payload,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at = excluded.updated_at
        `
      )
      .run({
        accountId,
        encryptedPayload,
        iv,
        authTag,
        updatedAt: nowIso()
      });
  }

  getEmailAccountSecret(accountId: string): { encryptedPayload: string; iv: string; authTag: string } | undefined {
    const row = this.db
      .prepare(
        `
        SELECT encrypted_payload, iv, auth_tag
        FROM email_account_secrets
        WHERE account_id = ?
        `
      )
      .get(accountId) as { encrypted_payload: string; iv: string; auth_tag: string } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      encryptedPayload: row.encrypted_payload,
      iv: row.iv,
      authTag: row.auth_tag
    };
  }

  setProviderCredentials(
    provider: string,
    publicIdentifier: string,
    encryptedPayload: string,
    iv: string,
    authTag: string
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO provider_credentials (
          provider,
          public_identifier,
          encrypted_payload,
          iv,
          auth_tag,
          updated_at
        )
        VALUES (@provider, @publicIdentifier, @encryptedPayload, @iv, @authTag, @updatedAt)
        ON CONFLICT(provider) DO UPDATE SET
          public_identifier = excluded.public_identifier,
          encrypted_payload = excluded.encrypted_payload,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at = excluded.updated_at
        `
      )
      .run({
        provider,
        publicIdentifier,
        encryptedPayload,
        iv,
        authTag,
        updatedAt: nowIso()
      });
  }

  getProviderCredentials(provider: string):
    | {
        provider: string;
        publicIdentifier: string;
        encryptedPayload: string;
        iv: string;
        authTag: string;
        updatedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `
        SELECT provider, public_identifier, encrypted_payload, iv, auth_tag, updated_at
        FROM provider_credentials
        WHERE provider = ?
        `
      )
      .get(provider) as ProviderCredentialRow | undefined;

    if (!row) return undefined;
    return {
      provider: row.provider,
      publicIdentifier: row.public_identifier,
      encryptedPayload: row.encrypted_payload,
      iv: row.iv,
      authTag: row.auth_tag,
      updatedAt: row.updated_at
    };
  }

  listProfiles(): AccessProfileWithAccounts[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, name, read_enabled, draft_enabled, send_enabled, created_at, updated_at
        FROM access_profiles
        ORDER BY created_at DESC
        `
      )
      .all() as Array<{
      id: string;
      name: string;
      read_enabled: number;
      draft_enabled: number;
      send_enabled: number;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      readEnabled: Boolean(row.read_enabled),
      draftEnabled: Boolean(row.draft_enabled),
      sendEnabled: Boolean(row.send_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountIds: this.getProfileAccountIds(row.id)
    }));
  }

  getProfile(profileId: string): AccessProfileWithAccounts | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, name, read_enabled, draft_enabled, send_enabled, created_at, updated_at
        FROM access_profiles
        WHERE id = ?
        `
      )
      .get(profileId) as
      | {
          id: string;
          name: string;
          read_enabled: number;
          draft_enabled: number;
          send_enabled: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      name: row.name,
      readEnabled: Boolean(row.read_enabled),
      draftEnabled: Boolean(row.draft_enabled),
      sendEnabled: Boolean(row.send_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountIds: this.getProfileAccountIds(row.id)
    };
  }

  listAccessTokens(profileId: string): Array<{
    id: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }> {
    return this.listAccessTokensByProfile(profileId);
  }

  listAccessTokensByProfile(profileId: string): Array<{
    id: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }> {
    return this.db
      .prepare(
        `
        SELECT id, token_prefix, created_at, last_used_at, revoked_at
        FROM access_tokens
        WHERE profile_id = ?
        ORDER BY created_at DESC
        `
      )
      .all(profileId)
      .map((row) => ({
        id: (row as { id: string }).id,
        tokenPrefix: (row as { token_prefix: string }).token_prefix,
        createdAt: (row as { created_at: string }).created_at,
        lastUsedAt: (row as { last_used_at: string | null }).last_used_at,
        revokedAt: (row as { revoked_at: string | null }).revoked_at
      }));
  }

  createProfile(profile: AccessProfile): void {
    this.db
      .prepare(
        `
        INSERT INTO access_profiles (id, name, read_enabled, draft_enabled, send_enabled, created_at, updated_at)
        VALUES (@id, @name, @readEnabled, @draftEnabled, @sendEnabled, @createdAt, @updatedAt)
        `
      )
      .run({
        id: profile.id,
        name: profile.name,
        readEnabled: profile.readEnabled ? 1 : 0,
        draftEnabled: profile.draftEnabled ? 1 : 0,
        sendEnabled: profile.sendEnabled ? 1 : 0,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt
      });
  }

  setProfileAccounts(profileId: string, accountIds: string[]): void {
    const exists = this.getProfile(profileId);
    if (!exists) {
      throw new Error(`Profile ${profileId} not found`);
    }

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM access_profile_accounts WHERE profile_id = ?').run(profileId);
      const insert = this.db.prepare('INSERT INTO access_profile_accounts(profile_id, account_id) VALUES (?, ?)');
      for (const accountId of accountIds) {
        insert.run(profileId, accountId);
      }
    })();
  }

  updateProfile(profile: AccessProfileWithAccounts): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE access_profiles
          SET name = @name,
              read_enabled = @readEnabled,
              draft_enabled = @draftEnabled,
              send_enabled = @sendEnabled,
              updated_at = @updatedAt
          WHERE id = @id
          `
        )
        .run({
          id: profile.id,
          name: profile.name,
          readEnabled: profile.readEnabled ? 1 : 0,
          draftEnabled: profile.draftEnabled ? 1 : 0,
          sendEnabled: profile.sendEnabled ? 1 : 0,
          updatedAt: nowIso()
        });

      this.setProfileAccounts(profile.id, profile.accountIds);
    })();
  }

  deleteProfile(profileId: string): void {
    this.db.prepare('DELETE FROM access_profiles WHERE id = ?').run(profileId);
  }

  getProfileAccountIds(profileId: string): string[] {
    return this.db
      .prepare('SELECT account_id FROM access_profile_accounts WHERE profile_id = ?')
      .all(profileId)
      .map((row) => (row as { account_id: string }).account_id);
  }

  createAccessToken(payload: {
    id: string;
    profileId: string;
    tokenHash: string;
    tokenPrefix: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO access_tokens (id, profile_id, token_hash, token_prefix, created_at)
        VALUES (@id, @profileId, @tokenHash, @tokenPrefix, @createdAt)
        `
      )
      .run({
        id: payload.id,
        profileId: payload.profileId,
        tokenHash: payload.tokenHash,
        tokenPrefix: payload.tokenPrefix,
        createdAt: nowIso()
      });
  }

  getToken(tokenHash: string): {
    id: string;
    profileId: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  } | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, profile_id, token_prefix, created_at, last_used_at, revoked_at
        FROM access_tokens
        WHERE token_hash = ?
        `
      )
      .get(tokenHash) as
      | {
          id: string;
          profile_id: string;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      profileId: row.profile_id,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    };
  }

  revokeAccessToken(profileId: string, tokenId: string): void {
    this.db
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND profile_id = ?')
      .run(nowIso(), tokenId, profileId);
  }

  countOauthStates(): number {
    return (this.db.prepare('SELECT COUNT(*) as total FROM oauth_states').get() as { total: number }).total;
  }

  getScopeContextForToken(tokenHash: string): ScopedAuthContext | undefined {
    const token = this.getToken(tokenHash);
    if (!token || token.revokedAt) {
      return undefined;
    }

    const profile = this.getProfile(token.profileId);
    if (!profile) {
      return undefined;
    }

    this.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), token.id);

    return {
      type: 'profile',
      profileId: profile.id,
      profile: {
        id: profile.id,
        name: profile.name,
        readEnabled: profile.readEnabled,
        draftEnabled: profile.draftEnabled,
        sendEnabled: profile.sendEnabled,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        accountIds: profile.accountIds
      },
      tokenId: token.id
    };
  }

  createOauthState(state: {
    state: string;
    provider: string;
    requestedAt: number;
    expiresAt: number;
    codeVerifier: string;
    meta: OAuthMetaState | Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO oauth_states (state, provider, requested_at, expires_at, code_verifier, meta_json)
        VALUES (@state, @provider, @requestedAt, @expiresAt, @codeVerifier, @meta)
        `
      )
      .run({
        state: state.state,
        provider: state.provider,
        requestedAt: state.requestedAt,
        expiresAt: state.expiresAt,
        codeVerifier: state.codeVerifier,
        meta: JSON.stringify(state.meta)
      });
  }

  consumeOauthState(state: string): OAuthState | undefined {
    const row = this.db
      .prepare(
        `
        SELECT state, provider, requested_at, expires_at, code_verifier, meta_json
        FROM oauth_states
        WHERE state = ?
        `
      )
      .get(state) as OAuthStateRow | undefined;

    if (!row) {
      return undefined;
    }

    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

    return {
      state: row.state,
      provider: row.provider,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      codeVerifier: row.code_verifier,
      meta: JSON.parse(row.meta_json) as OAuthMetaState | Record<string, unknown>
    };
  }

  purgeExpiredOauthStates(now = Date.now()): void {
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  }

  createSendOperation(input: {
    accountId: string;
    idempotencyKey: string;
    operation: 'send' | 'reply';
  }): { id: number } | undefined {
    try {
      const result = this.db
        .prepare(
          `
          INSERT INTO send_operations (account_id, idempotency_key, operation, status, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, ?)
          `
        )
        .run(input.accountId, input.idempotencyKey, input.operation, nowIso(), nowIso());

      return { id: Number(result.lastInsertRowid) };
    } catch {
      return undefined;
    }
  }

  getSendOperation(accountId: string, idempotencyKey: string): SendOperationRecord | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, account_id, idempotency_key, operation, status, provider_message_id, provider_thread_id, error_code, created_at, updated_at
        FROM send_operations
        WHERE account_id = ? AND idempotency_key = ?
        `
      )
      .get(accountId, idempotencyKey) as SendOperationRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      accountId: row.account_id,
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      status: row.status,
      providerMessageId: row.provider_message_id ?? undefined,
      providerThreadId: row.provider_thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorCode: row.error_code ?? undefined
    };
  }

  markSendOperationStatus(
    operationId: number,
    status: SendOperationRecord['status'],
    providerMessageId?: string | null,
    providerThreadId?: string | null,
    errorCode?: string | null
  ): void {
    this.db
      .prepare(
        `
        UPDATE send_operations
        SET status = ?,
            provider_message_id = ?,
            provider_thread_id = ?,
            error_code = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(status, providerMessageId ?? null, providerThreadId ?? null, errorCode ?? null, nowIso(), operationId);
  }

  countRecentSendAttempts(accountId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) as total
        FROM send_operations
        WHERE account_id = ? AND created_at >= ?
        `
      )
      .get(accountId, sinceIso) as { total: number };

    return row.total;
  }

  getAuditForOperation(accountId: string, idempotencyKey: string): SendOperationRecord | undefined {
    return this.getSendOperation(accountId, idempotencyKey);
  }

  close(): void {
    if (!this.db.open) return;
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // Another process may still hold the shared WAL. Closing remains safe.
    }
    this.db.close();
  }

  private mapAccount(row: EmailAccountRow): AccountRecord {
    return {
      id: row.id,
      provider: row.provider,
      emailAddress: row.email_address,
      displayName: row.display_name,
      enabled: Boolean(row.enabled),
      config: JSON.parse(row.config_json) as EmailAccountConfig,
      capabilities: this.providerCapabilities(row.provider),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastConnectionStatus: row.last_connection_status,
      lastConnectionAt: row.last_connection_at
    };
  }

  private providerCapabilities(provider: ProviderType): ProviderCapabilities {
    return capabilityMap[provider];
  }
}
