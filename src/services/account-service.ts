import { ApiError, ERROR_CODES } from '../types/errors.js';
import { createProvider } from '../providers/factory.js';
import { EncryptionService } from '../utils/crypto.js';
import {
  AccountRecord,
  EmailAccountConfig,
  ImapSmtpAccountConfig,
  GmailAccountConfig,
  OAuthMetaState
} from '../types/models.js';
import { RuntimeConfig } from '../config/env.js';
import { DatabaseService } from '../db/database.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { google } from 'googleapis';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ProtonBridgeAccountInput {
  emailAddress: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapTlsMode: 'ssl' | 'starttls' | 'none';
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: 'ssl' | 'starttls' | 'none';
  username: string;
  password: string;
  customCA?: string;
  customTls?: boolean;
  smtpMessageIdDomain?: string;
}

export interface ImapSmtpAccountInput {
  emailAddress: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapTlsMode: 'ssl' | 'starttls' | 'none';
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: 'ssl' | 'starttls' | 'none';
  username: string;
  password: string;
  customCA?: string;
  customTls?: boolean;
  smtpMessageIdDomain?: string;
}

export interface UpdateAccountInput {
  displayName?: string;
  imapHost?: string;
  imapPort?: number;
  imapTlsMode?: 'ssl' | 'starttls' | 'none';
  smtpHost?: string;
  smtpPort?: number;
  smtpTlsMode?: 'ssl' | 'starttls' | 'none';
  customCA?: string;
  customTls?: boolean;
  smtpMessageIdDomain?: string;
}

export interface UpdateAccountSecrets {
  username?: string;
  password?: string;
}

export interface GmailConnectOptions {
  returnUrl?: string;
}

export interface GmailCallbackInput {
  state: string;
  code: string;
}

export interface GoogleOAuthSettings {
  configured: boolean;
  clientId: string;
  hasClientSecret: boolean;
  source: 'stored' | 'environment' | 'missing';
  updatedAt: string | null;
}

export interface AccountServiceDependencies {
  db: DatabaseService;
  cryptoService: EncryptionService;
  config: RuntimeConfig;
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDependencies) {}

  listAccounts(): AccountRecord[] {
    return this.deps.db.getEmailAccounts();
  }

  getAccount(accountId: string): AccountRecord {
    const account = this.deps.db.getEmailAccountById(accountId);
    if (!account) {
      throw new ApiError(ERROR_CODES.ACCOUNT_NOT_FOUND, `Account ${accountId} not found`, 404);
    }
    return account;
  }

  private parseConfigForImap(input: ProtonBridgeAccountInput | ImapSmtpAccountInput): ImapSmtpAccountConfig {
    return {
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapTlsMode: input.imapTlsMode,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpTlsMode: input.smtpTlsMode,
      customCA: input.customCA,
      customTls: input.customTls,
      smtpMessageIdDomain: input.smtpMessageIdDomain
    };
  }

  createProtonBridgeAccount(input: ProtonBridgeAccountInput): AccountRecord {
    const id = randomUUID();
    const config = this.parseConfigForImap(input);
    this.deps.db.upsertEmailAccount({
      id,
      provider: 'proton_bridge',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: true,
      config
    });
    this.storeEncryptedSecrets(id, {
      username: input.username,
      password: input.password
    });
    return this.getAccount(id);
  }

  upsertManagedProtonBridgeAccount(input: ProtonBridgeAccountInput): AccountRecord {
    const existing = this.deps.db
      .getEmailAccounts()
      .find(
        (account) =>
          account.provider === 'proton_bridge' &&
          account.emailAddress.toLowerCase() === input.emailAddress.toLowerCase() &&
          (account.config as ImapSmtpAccountConfig).managedBridge === true
      );
    const id = existing?.id ?? randomUUID();
    const config: ImapSmtpAccountConfig = {
      ...this.parseConfigForImap(input),
      managedBridge: true
    };
    this.deps.db.upsertEmailAccount({
      id,
      provider: 'proton_bridge',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: true,
      config,
      connectionStatus: existing?.lastConnectionStatus ?? null,
      connectionAt: existing?.lastConnectionAt ?? null
    });
    this.storeEncryptedSecrets(id, {
      username: input.username,
      password: input.password
    });
    return this.getAccount(id);
  }

  createImapSmtpAccount(input: ImapSmtpAccountInput): AccountRecord {
    const id = randomUUID();
    const config = this.parseConfigForImap(input);
    this.deps.db.upsertEmailAccount({
      id,
      provider: 'imap_smtp',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: true,
      config
    });
    this.storeEncryptedSecrets(id, {
      username: input.username,
      password: input.password
    });
    return this.getAccount(id);
  }

  updateAccount(accountId: string, input: UpdateAccountInput, secrets?: UpdateAccountSecrets): AccountRecord {
    const account = this.getAccount(accountId);

    const nextConfig: EmailAccountConfig = {
      ...(account.config as object),
      ...(input as UpdateAccountInput)
    } as EmailAccountConfig;

    this.deps.db.upsertEmailAccount({
      id: account.id,
      provider: account.provider,
      emailAddress: account.emailAddress,
      displayName: input.displayName ?? account.displayName,
      enabled: account.enabled,
      config: nextConfig,
      connectionStatus: account.lastConnectionStatus,
      connectionAt: account.lastConnectionAt
    });

    if (secrets?.username || secrets?.password) {
      const current = this.getDecryptedSecrets(accountId);
      this.storeEncryptedSecrets(accountId, {
        username: secrets.username ?? current.username,
        password: secrets.password ?? current.password
      });
    }

    return this.getAccount(account.id);
  }

  deleteAccount(accountId: string): void {
    this.getAccount(accountId);
    this.deps.db.removeEmailAccount(accountId);
  }

  setEnabled(accountId: string, enabled: boolean): AccountRecord {
    this.getAccount(accountId);
    this.deps.db.setAccountEnabled(accountId, enabled);
    return this.getAccount(accountId);
  }

  async testAccount(accountId: string): Promise<{
    status: 'ok' | 'error';
    latencyMs: number;
    message?: string;
    provider: string;
    connectionStatus?: string | null;
  }> {
    const account = this.getAccount(accountId);
    if (!account.enabled) {
      throw new ApiError(ERROR_CODES.ACCOUNT_DISABLED, 'account disabled', 409);
    }

    const provider = await this.getProviderForAccount(accountId);
    const test = await provider.verifyConnection();

    this.deps.db.updateAccountConnectionStatus(
      accountId,
      test.status,
      new Date().toISOString()
    );

    if (test.status !== 'ok') {
      return {
        status: 'error',
        latencyMs: test.latencyMs,
        provider: account.provider,
        message: test.providerMessage,
        connectionStatus: test.providerMessage
      };
    }

    return {
      status: 'ok',
      latencyMs: test.latencyMs,
      provider: account.provider,
      message: test.providerMessage,
      connectionStatus: test.providerMessage
    };
  }

  async getProviderForAccount(accountId: string) {
    const account = this.getAccount(accountId);
    const row = this.deps.db.getEmailAccountSecret(accountId);
    if (!row) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Account secrets missing', 500);
    }

    const secret = this.deps.cryptoService.decrypt(row);
    const parsed = safeJsonParse<{
      username?: string;
      password?: string;
      refreshToken?: string;
    }>(secret);

    const google =
      account.provider === 'gmail'
        ? this.resolveGoogleOAuthCredentials()
        : {
            clientId: this.deps.config.googleClientId,
            clientSecret: this.deps.config.googleClientSecret
          };
    return createProvider(account, parsed, {
      ...this.deps.config,
      googleClientId: google.clientId,
      googleClientSecret: google.clientSecret
    });
  }

  getGoogleOAuthSettings(): GoogleOAuthSettings {
    const stored = this.deps.db.getProviderCredentials('google_oauth');
    if (stored) {
      return {
        configured: true,
        clientId: stored.publicIdentifier,
        hasClientSecret: true,
        source: 'stored',
        updatedAt: stored.updatedAt
      };
    }

    const configured = Boolean(
      this.deps.config.googleClientId && this.deps.config.googleClientSecret
    );
    return {
      configured,
      clientId: configured ? this.deps.config.googleClientId : '',
      hasClientSecret: configured,
      source: configured ? 'environment' : 'missing',
      updatedAt: null
    };
  }

  saveGoogleOAuthSettings(input: {
    clientId: string;
    clientSecret?: string;
  }): GoogleOAuthSettings {
    const existing = this.deps.db.getProviderCredentials('google_oauth');
    let clientSecret = input.clientSecret;
    if (!clientSecret && existing) {
      clientSecret = safeJsonParse<{ clientSecret: string }>(
        this.deps.cryptoService.decrypt(existing)
      ).clientSecret;
    }
    if (!clientSecret) {
      throw new ApiError(
        ERROR_CODES.INVALID_INPUT,
        'Google OAuth client secret is required when configuring stored credentials',
        400
      );
    }

    const encrypted = this.deps.cryptoService.encrypt(
      JSON.stringify({ clientSecret })
    );
    this.deps.db.setProviderCredentials(
      'google_oauth',
      input.clientId,
      encrypted.encryptedPayload,
      encrypted.iv,
      encrypted.authTag
    );
    return this.getGoogleOAuthSettings();
  }

  private resolveGoogleOAuthCredentials(): {
    clientId: string;
    clientSecret: string;
  } {
    const stored = this.deps.db.getProviderCredentials('google_oauth');
    if (stored) {
      const decrypted = safeJsonParse<{ clientSecret: string }>(
        this.deps.cryptoService.decrypt(stored)
      );
      return {
        clientId: stored.publicIdentifier,
        clientSecret: decrypted.clientSecret
      };
    }
    return {
      clientId: this.deps.config.googleClientId,
      clientSecret: this.deps.config.googleClientSecret
    };
  }

  private getDecryptedSecrets(accountId: string): { username?: string; password?: string; refreshToken?: string } {
    const row = this.deps.db.getEmailAccountSecret(accountId);
    if (!row) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Account secrets missing', 500);
    }
    return safeJsonParse<{ username?: string; password?: string; refreshToken?: string }>(
      this.deps.cryptoService.decrypt(row)
    );
  }

  private storeEncryptedSecrets(accountId: string, payload: { username?: string; password?: string; refreshToken?: string }): void {
    const encrypted = this.deps.cryptoService.encrypt(JSON.stringify(payload));
    this.deps.db.setEmailAccountSecret(accountId, encrypted.encryptedPayload, encrypted.iv, encrypted.authTag);
  }

  createGmailAuthorizationUrl(options: GmailConnectOptions = {}): {
    authorizationUrl: string;
    state: string;
    expiresAt: number;
    codeVerifier: string;
    codeChallenge: string;
  } {
    const state = randomBytes(16).toString('hex');
    const codeVerifier = generatePkceCodeVerifier();
    const codeChallenge = generatePkceCodeChallenge(codeVerifier);

    const redirectUri = options.returnUrl ?? this.deps.config.googleRedirectUri;
    const google = this.resolveGoogleOAuthCredentials();
    if (!google.clientId || !google.clientSecret) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Missing Google OAuth credentials', 400);
    }

    const url = GmailProviderBuildAuthorizationUrl({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      redirectUri,
      scopes: this.deps.config.gmailScopes,
      state,
      codeChallenge
    });

    const requestedAt = Date.now();
    const expiresAt = requestedAt + STATE_TTL_MS;
    this.deps.db.createOauthState({
      state,
      provider: 'gmail',
      requestedAt,
      expiresAt,
      codeVerifier,
      meta: {
        provider: 'gmail',
        returnUrl: options.returnUrl
      }
    });

    return {
      authorizationUrl: url,
      state,
      expiresAt,
      codeVerifier,
      codeChallenge
    };
  }

  async completeGmailConnection(params: GmailCallbackInput): Promise<{ accountId: string; emailAddress: string }> {
    const state = this.deps.db.consumeOauthState(params.state);
    if (!state) {
      throw new ApiError(ERROR_CODES.STATE_INVALID, 'invalid OAuth state', 400);
    }

    if (state.expiresAt < Date.now()) {
      throw new ApiError(ERROR_CODES.STATE_EXPIRED, 'OAuth state expired', 400);
    }

    if (state.provider !== 'gmail') {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, 'state provider mismatch', 400);
    }

    const meta = state.meta as OAuthMetaState;
    const googleCredentials = this.resolveGoogleOAuthCredentials();
    if (!googleCredentials.clientId || !googleCredentials.clientSecret) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Missing Google OAuth credentials', 400);
    }
    const googleAuth = new google.auth.OAuth2(
      googleCredentials.clientId,
      googleCredentials.clientSecret,
      meta.returnUrl ?? this.deps.config.googleRedirectUri
    );

    const result = await googleAuth.getToken({
      code: params.code,
      codeVerifier: state.codeVerifier
    });

    const refreshToken = result.tokens?.refresh_token;
    if (!refreshToken) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'No refresh token returned by Google', 400);
    }

    googleAuth.setCredentials(result.tokens);
    const gmail = google.gmail({ version: 'v1', auth: googleAuth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress;

    if (!emailAddress) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Could not determine Gmail account email', 400);
    }

    const id = randomUUID();
    const displayName = profile.data.emailAddress || emailAddress;
    const config: GmailAccountConfig = {
      emailAddress,
      displayName
    };

    this.deps.db.upsertEmailAccount({
      id,
      provider: 'gmail',
      emailAddress,
      displayName,
      enabled: true,
      config
    });

    this.storeEncryptedSecrets(id, { refreshToken });

    return {
      accountId: id,
      emailAddress
    };
  }

  listRecentOauthStates(): { total: number } {
    return { total: this.deps.db.countOauthStates() };
  }

  purgeExpiredOauthStates(): void {
    this.deps.db.purgeExpiredOauthStates();
  }
}

const safeJsonParse = <T>(value: string): T => {
  return JSON.parse(value) as T;
};

const generatePkceCodeVerifier = (): string => {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+/g, '');
};

const generatePkceCodeChallenge = (codeVerifier: string): string => {
  return createHash('sha256').update(codeVerifier).digest('base64url');
};

const GmailProviderBuildAuthorizationUrl = (input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string => {
  const client = new google.auth.OAuth2({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri
  });

  const options = {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: false,
    scope: input.scopes,
    state: input.state,
    code_challenge_method: 'S256' as unknown as 'S256',
    code_challenge: input.codeChallenge
  } as Parameters<typeof client.generateAuthUrl>[0];

  return client.generateAuthUrl(options);
};
