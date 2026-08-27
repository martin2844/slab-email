import { ApiError, ERROR_CODES } from '../types/errors.js';
import { createProvider } from '../providers/factory.js';
import { EncryptionService } from '../utils/crypto.js';
import {
  AccountRecord,
  EmailAccountConfig,
  ImapSmtpAccountConfig,
  GmailAccountConfig,
  OAuthMetaState,
  AgentMailAccountConfig,
  ResendAccountConfig,
  MicrosoftGraphAccountConfig,
} from '../types/models.js';
import { RuntimeConfig } from '../config/env.js';
import { DatabaseService } from '../db/database.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { google } from 'googleapis';
import { providerJson } from '../providers/http-json.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const INBOUND_CONFIG_KEYS: ReadonlyArray<keyof UpdateAccountInput> = [
  'imapHost',
  'imapPort',
  'imapTlsMode',
  'customCA',
  'customTls',
  'inboxId',
  'baseUrl',
  'inboundEnabled'
];

const configValue = (
  config: EmailAccountConfig,
  key: keyof UpdateAccountInput
): unknown => (config as unknown as Record<string, unknown>)[key];

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

export interface AgentMailAccountInput {
  emailAddress: string;
  displayName: string;
  inboxId: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ResendAccountInput {
  emailAddress: string;
  displayName: string;
  apiKey: string;
  inboundEnabled?: boolean;
  baseUrl?: string;
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
  inboxId?: string;
  baseUrl?: string;
  inboundEnabled?: boolean;
}

export interface UpdateAccountSecrets {
  username?: string;
  password?: string;
  apiKey?: string;
}

export interface GmailConnectOptions {
  returnUrl?: string;
}

export interface GmailCallbackInput {
  state: string;
  code: string;
}

export type MicrosoftConnectOptions = GmailConnectOptions;
export type MicrosoftCallbackInput = GmailCallbackInput;

export interface GoogleOAuthSettings {
  configured: boolean;
  clientId: string;
  hasClientSecret: boolean;
  source: 'stored' | 'environment' | 'missing';
  updatedAt: string | null;
}

export interface MicrosoftOAuthSettings extends GoogleOAuthSettings {
  tenant: string;
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
    this.persistAccount({
      id,
      provider: 'proton_bridge',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: true,
      config
    }, {
      username: input.username,
      password: input.password
    });
    return this.getAccount(id);
  }

  upsertManagedProtonBridgeAccount(
    input: ProtonBridgeAccountInput & { managedBridgeLogin?: string }
  ): AccountRecord {
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
      managedBridge: true,
      managedBridgeLogin: input.managedBridgeLogin ?? input.emailAddress
    };
    const currentSecrets = existing ? this.getDecryptedSecrets(existing.id) : undefined;
    const advanceInboundGeneration = !existing ||
      INBOUND_CONFIG_KEYS.some(
        (key) => !Object.is(configValue(existing.config, key), configValue(config, key))
      ) ||
      currentSecrets?.username !== input.username ||
      currentSecrets?.password !== input.password;
    this.persistAccount({
      id,
      provider: 'proton_bridge',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: existing?.enabled ?? true,
      config,
      connectionStatus: existing?.lastConnectionStatus ?? null,
      connectionAt: existing?.lastConnectionAt ?? null
    }, {
      username: input.username,
      password: input.password
    }, advanceInboundGeneration);
    return this.getAccount(id);
  }

  createImapSmtpAccount(input: ImapSmtpAccountInput): AccountRecord {
    const id = randomUUID();
    const config = this.parseConfigForImap(input);
    this.persistAccount({
      id,
      provider: 'imap_smtp',
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      enabled: true,
      config
    }, {
      username: input.username,
      password: input.password
    });
    return this.getAccount(id);
  }

  createAgentMailAccount(input: AgentMailAccountInput): AccountRecord {
    const id = randomUUID();
    const config: AgentMailAccountConfig = {
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      inboxId: input.inboxId,
      baseUrl: (input.baseUrl || 'https://api.agentmail.to/v0').replace(/\/$/, ''),
    };
    this.persistAccount({
      id, provider: 'agentmail', emailAddress: input.emailAddress,
      displayName: input.displayName, enabled: true, config,
    }, { apiKey: input.apiKey });
    return this.getAccount(id);
  }

  createResendAccount(input: ResendAccountInput): AccountRecord {
    const id = randomUUID();
    const config: ResendAccountConfig = {
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      baseUrl: (input.baseUrl || 'https://api.resend.com').replace(/\/$/, ''),
      inboundEnabled: input.inboundEnabled ?? false,
    };
    this.persistAccount({
      id, provider: 'resend', emailAddress: input.emailAddress,
      displayName: input.displayName, enabled: true, config,
    }, { apiKey: input.apiKey });
    return this.getAccount(id);
  }

  updateAccount(accountId: string, input: UpdateAccountInput, secrets?: UpdateAccountSecrets): AccountRecord {
    const account = this.getAccount(accountId);

    if (
      (account.provider === 'agentmail' || account.provider === 'resend') &&
      input.baseUrl &&
      'baseUrl' in account.config &&
      new URL(input.baseUrl).origin !== new URL(account.config.baseUrl).origin &&
      !secrets?.apiKey
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_INPUT,
        'A new API key is required when changing the provider origin',
        400
      );
    }

    const nextConfig: EmailAccountConfig = {
      ...(account.config as object),
      ...(input as UpdateAccountInput)
    } as EmailAccountConfig;

    let inboundSecretsChanged = false;
    const nextSecrets = secrets?.username || secrets?.password || secrets?.apiKey
      ? (() => {
          const current = this.getDecryptedSecrets(accountId);
          inboundSecretsChanged =
            (secrets.username !== undefined && secrets.username !== current.username) ||
            (secrets.password !== undefined && secrets.password !== current.password) ||
            (secrets.apiKey !== undefined && secrets.apiKey !== current.apiKey);
          return {
            username: secrets.username ?? current.username,
            password: secrets.password ?? current.password,
            refreshToken: current.refreshToken,
            apiKey: secrets.apiKey ?? current.apiKey
          };
        })()
      : undefined;
    const inboundConfigChanged = INBOUND_CONFIG_KEYS.some(
      (key) => key in input &&
        !Object.is(configValue(account.config, key), configValue(nextConfig, key))
    );

    this.persistAccount({
      id: account.id,
      provider: account.provider,
      emailAddress: account.emailAddress,
      displayName: input.displayName ?? account.displayName,
      enabled: account.enabled,
      config: nextConfig,
      connectionStatus: account.lastConnectionStatus,
      connectionAt: account.lastConnectionAt
    }, nextSecrets, inboundConfigChanged || inboundSecretsChanged);

    return this.getAccount(account.id);
  }

  deleteAccount(accountId: string): void {
    this.getAccount(accountId);
    if (this.isAccountAssigned(accountId)) {
      throw new ApiError(
        ERROR_CODES.ACCOUNT_IN_USE,
        'Remove this account from every access profile before deleting it.',
        409
      );
    }
    this.deps.db.removeEmailAccount(accountId);
  }

  isAccountAssigned(accountId: string): boolean {
    return this.deps.db
      .listProfiles()
      .some((profile) => profile.accountIds.includes(accountId));
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
      apiKey?: string;
    }>(secret);

    const google = account.provider === 'gmail'
      ? this.resolveGoogleOAuthCredentials()
      : { clientId: this.deps.config.googleClientId, clientSecret: this.deps.config.googleClientSecret };
    const microsoft = account.provider === 'microsoft_graph'
      ? this.resolveMicrosoftOAuthCredentials()
      : {
          clientId: this.deps.config.microsoftClientId,
          clientSecret: this.deps.config.microsoftClientSecret,
          tenant: this.deps.config.microsoftTenant,
        };
    return createProvider(account, parsed, {
      ...this.deps.config,
      googleClientId: google.clientId,
      googleClientSecret: google.clientSecret,
      microsoftClientId: microsoft.clientId,
      microsoftClientSecret: microsoft.clientSecret,
      microsoftTenant: microsoft.tenant,
    });
  }

  async getInboundProviderSnapshot(accountId: string) {
    const generation = this.deps.db.getEmailAccountInboundGeneration(accountId);
    if (generation === undefined) {
      throw new ApiError(ERROR_CODES.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    }
    const account = this.getAccount(accountId);
    const provider = await this.getProviderForAccount(accountId);
    if (this.deps.db.getEmailAccountInboundGeneration(accountId) !== generation) {
      throw new Error('email account changed while creating provider');
    }
    return { account, generation, provider };
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

  getMicrosoftOAuthSettings(): MicrosoftOAuthSettings {
    const stored = this.deps.db.getProviderCredentials('microsoft_oauth');
    if (stored) {
      const value = safeJsonParse<{ clientSecret: string; tenant: string }>(this.deps.cryptoService.decrypt(stored));
      return {
        configured: true, clientId: stored.publicIdentifier, hasClientSecret: true,
        source: 'stored', updatedAt: stored.updatedAt, tenant: value.tenant || 'common',
      };
    }
    const configured = Boolean(this.deps.config.microsoftClientId && this.deps.config.microsoftClientSecret);
    return {
      configured, clientId: configured ? this.deps.config.microsoftClientId : '',
      hasClientSecret: configured, source: configured ? 'environment' : 'missing',
      updatedAt: null, tenant: this.deps.config.microsoftTenant || 'common',
    };
  }

  saveMicrosoftOAuthSettings(input: { clientId: string; clientSecret?: string; tenant?: string }): MicrosoftOAuthSettings {
    const existing = this.deps.db.getProviderCredentials('microsoft_oauth');
    const current = existing
      ? safeJsonParse<{ clientSecret: string; tenant: string }>(this.deps.cryptoService.decrypt(existing))
      : undefined;
    const clientSecret = input.clientSecret || current?.clientSecret;
    if (!clientSecret) throw new ApiError(ERROR_CODES.INVALID_INPUT, 'Microsoft OAuth client secret is required', 400);
    const encrypted = this.deps.cryptoService.encrypt(JSON.stringify({ clientSecret, tenant: input.tenant || current?.tenant || 'common' }));
    this.deps.db.setProviderCredentials('microsoft_oauth', input.clientId, encrypted.encryptedPayload, encrypted.iv, encrypted.authTag);
    return this.getMicrosoftOAuthSettings();
  }

  private resolveMicrosoftOAuthCredentials() {
    const stored = this.deps.db.getProviderCredentials('microsoft_oauth');
    if (stored) {
      const value = safeJsonParse<{ clientSecret: string; tenant: string }>(this.deps.cryptoService.decrypt(stored));
      return { clientId: stored.publicIdentifier, clientSecret: value.clientSecret, tenant: value.tenant || 'common' };
    }
    return {
      clientId: this.deps.config.microsoftClientId,
      clientSecret: this.deps.config.microsoftClientSecret,
      tenant: this.deps.config.microsoftTenant || 'common',
    };
  }

  private getDecryptedSecrets(accountId: string): { username?: string; password?: string; refreshToken?: string; apiKey?: string } {
    const row = this.deps.db.getEmailAccountSecret(accountId);
    if (!row) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Account secrets missing', 500);
    }
    return safeJsonParse<{ username?: string; password?: string; refreshToken?: string; apiKey?: string }>(
      this.deps.cryptoService.decrypt(row)
    );
  }

  private encryptSecrets(payload: {
    username?: string;
    password?: string;
    refreshToken?: string;
    apiKey?: string;
  }) {
    const encrypted = this.deps.cryptoService.encrypt(JSON.stringify(payload));
    return {
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      authTag: encrypted.authTag
    };
  }

  private persistAccount(
    account: Parameters<DatabaseService['upsertEmailAccount']>[0],
    secrets?: {
      username?: string;
      password?: string;
      refreshToken?: string;
      apiKey?: string;
    },
    advanceInboundGeneration = true
  ): void {
    this.deps.db.upsertEmailAccountWithSecret(
      account,
      secrets ? this.encryptSecrets(secrets) : undefined,
      advanceInboundGeneration
    );
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

    this.persistAccount({
      id,
      provider: 'gmail',
      emailAddress,
      displayName,
      enabled: true,
      config
    }, { refreshToken });

    return {
      accountId: id,
      emailAddress
    };
  }

  createMicrosoftAuthorizationUrl(options: MicrosoftConnectOptions = {}) {
    const credentials = this.resolveMicrosoftOAuthCredentials();
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Missing Microsoft OAuth credentials', 400);
    }
    const state = randomBytes(16).toString('hex');
    const codeVerifier = generatePkceCodeVerifier();
    const codeChallenge = generatePkceCodeChallenge(codeVerifier);
    const redirectUri = options.returnUrl ?? this.deps.config.microsoftRedirectUri;
    const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(credentials.tenant)}/oauth2/v2.0/authorize`);
    authorize.search = new globalThis.URLSearchParams({
      client_id: credentials.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'offline_access openid profile email Mail.ReadWrite Mail.Send',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    const requestedAt = Date.now();
    const expiresAt = requestedAt + STATE_TTL_MS;
    this.deps.db.createOauthState({
      state, provider: 'microsoft_graph', requestedAt, expiresAt, codeVerifier,
      meta: { provider: 'microsoft_graph', returnUrl: options.returnUrl },
    });
    return { authorizationUrl: authorize.toString(), state, expiresAt };
  }

  async completeMicrosoftConnection(params: MicrosoftCallbackInput): Promise<{ accountId: string; emailAddress: string }> {
    const state = this.deps.db.consumeOauthState(params.state);
    if (!state) throw new ApiError(ERROR_CODES.STATE_INVALID, 'invalid OAuth state', 400);
    if (state.expiresAt < Date.now()) throw new ApiError(ERROR_CODES.STATE_EXPIRED, 'OAuth state expired', 400);
    if (state.provider !== 'microsoft_graph') throw new ApiError(ERROR_CODES.INVALID_INPUT, 'state provider mismatch', 400);
    const credentials = this.resolveMicrosoftOAuthCredentials();
    const meta = state.meta as OAuthMetaState;
    const redirectUri = meta.returnUrl ?? this.deps.config.microsoftRedirectUri;
    const token = await providerJson<{ access_token: string; refresh_token?: string }>(
      `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new globalThis.URLSearchParams({
          client_id: credentials.clientId, client_secret: credentials.clientSecret,
          code: params.code, redirect_uri: redirectUri, grant_type: 'authorization_code',
          code_verifier: state.codeVerifier,
          scope: 'offline_access openid profile email Mail.ReadWrite Mail.Send',
        }),
      },
    );
    if (!token.refresh_token) throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'No refresh token returned by Microsoft', 400);
    const me = await providerJson<{ displayName?: string; mail?: string; userPrincipalName?: string }>(
      'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    const emailAddress = me.mail || me.userPrincipalName;
    if (!emailAddress) throw new ApiError(ERROR_CODES.INVALID_CONFIGURATION, 'Could not determine Microsoft account email', 400);
    const id = randomUUID();
    const displayName = me.displayName || emailAddress;
    const config: MicrosoftGraphAccountConfig = { emailAddress, displayName, tenant: credentials.tenant };
    this.persistAccount(
      { id, provider: 'microsoft_graph', emailAddress, displayName, enabled: true, config },
      { refreshToken: token.refresh_token }
    );
    return { accountId: id, emailAddress };
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
