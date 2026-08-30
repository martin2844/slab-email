import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EMAIL_SCHEMA_VERSIONS, runMigrations } from './migrations.js';

import {
  AccessProfile,
  AccessProfileWithAccounts,
  AccountRecord,
  EmailAccountConfig,
  EmailMessageCompact,
  InboundEmailEvent,
  InboundPollState,
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
  },
  microsoft_graph: {
    read: true,
    search: true,
    draft: true,
    send: true,
    reply: true,
    threads: true
  },
  agentmail: {
    read: true,
    search: true,
    draft: true,
    send: true,
    reply: true,
    threads: true
  },
  resend: {
    read: true,
    search: true,
    draft: false,
    send: true,
    reply: false,
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

interface InboundEventRow {
  id: number;
  account_id: string;
  provider: ProviderType;
  message_id: string;
  thread_id: string | null;
  from_json: string;
  to_json: string;
  subject: string;
  received_at: string;
  discovered_at: string;
}

export class InboundScanStateChangedError extends Error {}

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
    runMigrations(this.db);
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
    const expected = [...EMAIL_SCHEMA_VERSIONS];
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

  getEmailAccountInboundGeneration(accountId: string): number | undefined {
    const row = this.db
      .prepare('SELECT inbound_generation FROM email_accounts WHERE id=?')
      .get(accountId) as { inbound_generation: number } | undefined;
    return row?.inbound_generation;
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
  }, advanceInboundGeneration = true): void {
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
              last_connection_at=@at,
              inbound_generation=inbound_generation+@advanceInboundGeneration
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
          at: data.connectionAt ?? null,
          advanceInboundGeneration: advanceInboundGeneration ? 1 : 0
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

  upsertEmailAccountWithSecret(
    data: Parameters<DatabaseService['upsertEmailAccount']>[0],
    secret?: { encryptedPayload: string; iv: string; authTag: string },
    advanceInboundGeneration = true
  ): void {
    this.db.transaction(() => {
      this.upsertEmailAccount(data, advanceInboundGeneration);
      if (secret) {
        this.setEmailAccountSecret(
          data.id,
          secret.encryptedPayload,
          secret.iv,
          secret.authTag
        );
      }
    }).immediate();
  }

  removeEmailAccount(id: string): void {
    this.db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
  }

  setAccountEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(
        `UPDATE email_accounts SET
           enabled=?,updated_at=?,inbound_generation=inbound_generation+1
         WHERE id=? AND enabled<>?`
      )
      .run(enabled ? 1 : 0, nowIso(), id, enabled ? 1 : 0);
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
      const create = this.db.transaction(() => {
        const timestamp = nowIso();
        const result = this.db
          .prepare(
            `
            INSERT INTO send_operations (account_id, idempotency_key, operation, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
            `
          )
          .run(input.accountId, input.idempotencyKey, input.operation, timestamp, timestamp);
        this.db
          .prepare('INSERT INTO send_attempts (account_id, attempted_at) VALUES (?, ?)')
          .run(input.accountId, timestamp);
        return { id: Number(result.lastInsertRowid) };
      });
      return create.immediate();
    } catch {
      return undefined;
    }
  }

  claimFailedSendOperation(operationId: number): boolean {
    const claim = this.db.transaction(() => {
      const timestamp = nowIso();
      const operation = this.db
        .prepare(
          `
          UPDATE send_operations
          SET status = 'pending', error_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'failed'
          RETURNING account_id
          `
        )
        .get(timestamp, operationId) as { account_id: string } | undefined;
      if (!operation) return false;
      this.db
        .prepare('INSERT INTO send_attempts (account_id, attempted_at) VALUES (?, ?)')
        .run(operation.account_id, timestamp);
      return true;
    });
    return claim.immediate();
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
        FROM send_attempts
        WHERE account_id = ? AND attempted_at >= ?
        `
      )
      .get(accountId, sinceIso) as { total: number };

    return row.total;
  }

  getAuditForOperation(accountId: string, idempotencyKey: string): SendOperationRecord | undefined {
    return this.getSendOperation(accountId, idempotencyKey);
  }

  getInboundPollState(accountId: string): InboundPollState | undefined {
    const row = this.db
      .prepare(
        `SELECT account_id,initialized_at,last_successful_poll_at,last_error,scan_cursor,scan_started_at,identity_epoch,account_generation,updated_at
         FROM inbound_poll_state WHERE account_id=?`
      )
      .get(accountId) as
      | {
          account_id: string;
          initialized_at: string | null;
          last_successful_poll_at: string | null;
          last_error: string | null;
          scan_cursor: string | null;
          scan_started_at: string | null;
          identity_epoch: string | null;
          account_generation: number;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          accountId: row.account_id,
          initializedAt: row.initialized_at,
          lastSuccessfulPollAt: row.last_successful_poll_at,
          lastError: row.last_error,
          scanCursor: row.scan_cursor,
          scanStartedAt: row.scan_started_at,
          identityEpoch: row.identity_epoch,
          accountGeneration: row.account_generation,
          updatedAt: row.updated_at
        }
      : undefined;
  }

  listInboundPollStates(): InboundPollState[] {
    return this.getEmailAccounts().flatMap((account) => {
      const state = this.getInboundPollState(account.id);
      return state ? [state] : [];
    });
  }

  hasSeenInboundMessageBefore(
    accountId: string,
    messageId: string,
    before: string
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM inbound_seen_messages
           WHERE account_id=? AND message_id=? AND first_seen_at<?`
        )
        .get(accountId, messageId, before)
    );
  }

  beginInboundScan(
    accountId: string,
    accountGeneration: number,
    scanStartedAt: string
  ): InboundPollState {
    return this.db.transaction(() => {
      const current = this.getInboundPollState(accountId);
      if (!current) {
        this.db
          .prepare(
            `INSERT INTO inbound_poll_state
             (account_id,initialized_at,last_successful_poll_at,last_error,scan_cursor,scan_started_at,identity_epoch,account_generation,updated_at)
             VALUES (?,NULL,NULL,NULL,NULL,?,NULL,?,?)`
          )
          .run(accountId, scanStartedAt, accountGeneration, scanStartedAt);
      } else if (current.accountGeneration !== accountGeneration) {
        this.db
          .prepare(
            `UPDATE inbound_poll_state SET
               initialized_at=NULL,last_successful_poll_at=NULL,last_error=NULL,
               scan_cursor=NULL,scan_started_at=?,identity_epoch=NULL,
               account_generation=?,updated_at=?
             WHERE account_id=?`
          )
          .run(scanStartedAt, accountGeneration, scanStartedAt, accountId);
        this.db
          .prepare('DELETE FROM inbound_seen_messages WHERE account_id=?')
          .run(accountId);
      } else {
        this.db
          .prepare(
            `UPDATE inbound_poll_state SET
               scan_started_at=COALESCE(scan_started_at,?),
               last_error=NULL,updated_at=?
             WHERE account_id=?`
          )
          .run(scanStartedAt, scanStartedAt, accountId);
      }
      return this.getInboundPollState(accountId)!;
    })();
  }

  recordInboundPage(input: {
    account: AccountRecord;
    messages: EmailMessageCompact[];
    emitEvents: boolean;
    discoveredAt: string;
    scanStartedAt: string;
    expectedCursor?: string;
    nextCursor?: string;
    complete: boolean;
    expectedIdentityEpoch?: string;
    identityEpoch?: string;
    accountGeneration: number;
  }): { discovered: number; emitted: number } {
    return this.db.transaction(() => {
      const currentAccount = this.db
        .prepare(
          `SELECT 1 FROM email_accounts
           WHERE id=? AND enabled=1 AND inbound_generation=?`
        )
        .get(input.account.id, input.accountGeneration);
      if (!currentAccount) {
        throw new InboundScanStateChangedError('inbound account state changed');
      }
      let discovered = 0;
      let emitted = 0;
      const insertSeen = this.db.prepare(
        `INSERT OR IGNORE INTO inbound_seen_messages
         (account_id,message_id,message_date,first_seen_at) VALUES (?,?,?,?)`
      );
      const insertEvent = this.db.prepare(
        `INSERT OR IGNORE INTO inbound_events
         (account_id,provider,message_id,thread_id,from_json,to_json,subject,received_at,discovered_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      );
      for (const message of input.messages) {
        const seen = insertSeen.run(
          input.account.id,
          message.id,
          message.date,
          input.discoveredAt
        );
        if (seen.changes !== 1) continue;
        discovered += 1;
        if (!input.emitEvents) continue;
        const event = insertEvent.run(
          input.account.id,
          input.account.provider,
          message.id,
          message.threadId ?? null,
          JSON.stringify(message.from),
          JSON.stringify(message.to),
          message.subject,
          message.date,
          input.discoveredAt
        );
        emitted += event.changes;
      }
      const advanced = input.complete
        ? this.db
            .prepare(
              `UPDATE inbound_poll_state SET
                 initialized_at=COALESCE(initialized_at,?),
                 last_successful_poll_at=?,
                 last_error=NULL,
                 scan_cursor=NULL,
                 scan_started_at=NULL,
                 identity_epoch=?,
                 updated_at=?
               WHERE account_id=? AND scan_started_at=? AND scan_cursor IS ?
                 AND identity_epoch IS ? AND account_generation=?`
            )
            .run(
              input.discoveredAt,
              input.scanStartedAt,
              input.identityEpoch ?? null,
              input.discoveredAt,
              input.account.id,
              input.scanStartedAt,
              input.expectedCursor ?? null,
              input.expectedIdentityEpoch ?? null,
              input.accountGeneration
            ).changes
        : this.db
            .prepare(
              `UPDATE inbound_poll_state SET
                 scan_cursor=?,identity_epoch=?,last_error=NULL,updated_at=?
               WHERE account_id=? AND scan_started_at=? AND scan_cursor IS ?
                 AND identity_epoch IS ? AND account_generation=?`
            )
            .run(
              input.nextCursor,
              input.identityEpoch ?? null,
              input.discoveredAt,
              input.account.id,
              input.scanStartedAt,
              input.expectedCursor ?? null,
              input.expectedIdentityEpoch ?? null,
              input.accountGeneration
            ).changes;
      if (advanced !== 1) throw new InboundScanStateChangedError(
        'inbound scan state changed'
      );
      return { discovered, emitted };
    })();
  }

  rebaselineInboundIdentity(input: {
    accountId: string;
    scanStartedAt: string;
    expectedCursor?: string;
    expectedIdentityEpoch: string;
    identityEpoch: string;
    restartedAt: string;
    accountGeneration: number;
  }): void {
    this.db.transaction(() => {
      const currentAccount = this.db
        .prepare(
          `SELECT 1 FROM email_accounts
           WHERE id=? AND enabled=1 AND inbound_generation=?`
        )
        .get(input.accountId, input.accountGeneration);
      if (!currentAccount) {
        throw new InboundScanStateChangedError('inbound account state changed');
      }
      const changed = this.db
        .prepare(
          `UPDATE inbound_poll_state SET
             initialized_at=NULL,
             last_successful_poll_at=NULL,
             last_error=NULL,
             scan_cursor=NULL,
             scan_started_at=?,
             identity_epoch=?,
             updated_at=?
           WHERE account_id=? AND scan_started_at=? AND scan_cursor IS ?
             AND identity_epoch=? AND account_generation=?`
        )
        .run(
          input.restartedAt,
          input.identityEpoch,
          input.restartedAt,
          input.accountId,
          input.scanStartedAt,
          input.expectedCursor ?? null,
          input.expectedIdentityEpoch,
          input.accountGeneration
        ).changes;
      if (changed !== 1) {
        throw new InboundScanStateChangedError('inbound scan state changed');
      }
      this.db
        .prepare('DELETE FROM inbound_seen_messages WHERE account_id=?')
        .run(input.accountId);
    })();
  }

  markInboundPollError(
    accountId: string,
    message: string,
    scanStartedAt: string,
    accountGeneration: number,
    expectedCursor?: string
  ): boolean {
    return this.db
      .prepare(
        `UPDATE inbound_poll_state SET
           last_error=?,
           scan_cursor=CASE WHEN ? THEN NULL ELSE scan_cursor END,
           updated_at=?
         WHERE account_id=? AND scan_started_at=? AND scan_cursor IS ?
           AND account_generation=?`
      )
      .run(
        message.slice(0, 500),
        expectedCursor === undefined ? 0 : 1,
        nowIso(),
        accountId,
        scanStartedAt,
        expectedCursor ?? null,
        accountGeneration
      ).changes === 1;
  }

  listInboundEvents(input: {
    afterId?: number;
    accountId?: string;
    limit?: number;
  }): { items: InboundEmailEvent[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
    const afterId = Math.max(0, input.afterId ?? 0);
    const rows = (input.accountId
      ? this.db
          .prepare(
            `SELECT * FROM inbound_events
             WHERE id>? AND account_id=? ORDER BY id LIMIT ?`
          )
          .all(afterId, input.accountId, limit)
      : this.db
          .prepare('SELECT * FROM inbound_events WHERE id>? ORDER BY id LIMIT ?')
          .all(afterId, limit)) as InboundEventRow[];
    const items = rows.map((row): InboundEmailEvent => ({
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      messageId: row.message_id,
      threadId: row.thread_id,
      from: JSON.parse(row.from_json) as InboundEmailEvent['from'],
      to: JSON.parse(row.to_json) as InboundEmailEvent['to'],
      subject: row.subject,
      receivedAt: row.received_at,
      discoveredAt: row.discovered_at
    }));
    return {
      items,
      nextCursor: items.length ? String(items.at(-1)!.id) : null
    };
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
    const config = JSON.parse(row.config_json) as EmailAccountConfig;
    const capabilities = { ...this.providerCapabilities(row.provider) };
    if (row.provider === 'resend' && !('inboundEnabled' in config && config.inboundEnabled)) {
      capabilities.read = false;
      capabilities.search = false;
    }
    return {
      id: row.id,
      provider: row.provider,
      emailAddress: row.email_address,
      displayName: row.display_name,
      enabled: Boolean(row.enabled),
      config,
      capabilities,
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
