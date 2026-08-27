import { RuntimeConfig } from '../config/env.js';
import {
  AccountRecord,
  AgentMailAccountConfig,
  ImapSmtpAccountConfig,
  MicrosoftGraphAccountConfig,
  ResendAccountConfig,
} from '../types/models.js';
import { AgentMailProvider } from './agentmail/provider.js';
import { GenericImapSmtpProvider } from './imap-smtp/generic.js';
import type { GenericImapSmtpProviderConfig } from './imap-smtp/types.js';
import { GmailProvider } from './gmail/provider.js';
import { ProtonBridgeProvider } from './proton-bridge/provider.js';
import { MicrosoftGraphProvider } from './microsoft-graph/provider.js';
import { ResendProvider } from './resend/provider.js';
import type { Provider } from './types.js';

export interface SecretBundle {
  username?: string;
  password?: string;
  refreshToken?: string;
  apiKey?: string;
}

export const shouldTrustDockerDesktopBridge = (
  provider: AccountRecord['provider'],
  imapHost: string,
  smtpHost: string
): boolean =>
  provider === 'proton_bridge' &&
  imapHost === 'host.docker.internal' &&
  smtpHost === 'host.docker.internal';

const toGenericConfig = (account: AccountRecord, secret: SecretBundle): GenericImapSmtpProviderConfig => {
  const cfg = account.config as ImapSmtpAccountConfig;
  if (!cfg?.imapHost || !cfg?.smtpHost) {
    throw new Error('Missing IMAP/SMTP account configuration');
  }

  const username = secret.username || account.emailAddress;
  const password = secret.password;
  const dockerDesktopBridge = shouldTrustDockerDesktopBridge(
    account.provider,
    cfg.imapHost,
    cfg.smtpHost
  );
  if (!password) {
    throw new Error('Missing IMAP/SMTP password');
  }

  return {
    emailAddress: account.emailAddress,
    displayName: account.displayName,
    imap: {
      imapHost: cfg.imapHost,
      imapPort: cfg.imapPort,
      imapTlsMode: cfg.imapTlsMode,
      username,
      password,
      imapCustomCa: cfg.customCA,
      imapAllowInsecure: cfg.customTls || dockerDesktopBridge
    },
    smtp: {
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpTlsMode: cfg.smtpTlsMode,
      smtpCustomCa: cfg.customCA,
      smtpAllowInsecure: cfg.customTls || dockerDesktopBridge,
      fromName: account.displayName,
      fromAddress: account.emailAddress,
      smtpMessageIdDomain: cfg.smtpMessageIdDomain,
      username,
      password
    }
  };
};

export const createProvider = (
  account: AccountRecord,
  secret: SecretBundle,
  runtimeConfig: RuntimeConfig
): Provider => {
  if (account.provider === 'gmail') {
    if (!secret.refreshToken) {
      throw new Error('Missing Gmail refresh token');
    }
    return new GmailProvider({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      refreshToken: secret.refreshToken,
      clientId: runtimeConfig.googleClientId,
      clientSecret: runtimeConfig.googleClientSecret,
      redirectUri: runtimeConfig.googleRedirectUri,
      scopes: runtimeConfig.gmailScopes
    });
  }

  if (account.provider === 'microsoft_graph') {
    const cfg = account.config as MicrosoftGraphAccountConfig;
    if (!secret.refreshToken) throw new Error('Missing Microsoft refresh token');
    return new MicrosoftGraphProvider({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      refreshToken: secret.refreshToken,
      clientId: runtimeConfig.microsoftClientId,
      clientSecret: runtimeConfig.microsoftClientSecret,
      tenant: cfg.tenant || runtimeConfig.microsoftTenant,
    });
  }

  if (account.provider === 'agentmail') {
    const cfg = account.config as AgentMailAccountConfig;
    if (!secret.apiKey) throw new Error('Missing AgentMail API key');
    return new AgentMailProvider({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      inboxId: cfg.inboxId,
      baseUrl: cfg.baseUrl,
      apiKey: secret.apiKey,
    });
  }

  if (account.provider === 'resend') {
    const cfg = account.config as ResendAccountConfig;
    if (!secret.apiKey) throw new Error('Missing Resend API key');
    return new ResendProvider({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      baseUrl: cfg.baseUrl,
      inboundEnabled: cfg.inboundEnabled,
      apiKey: secret.apiKey,
    });
  }

  const genericCfg = toGenericConfig(account, secret);
  if (account.provider === 'proton_bridge') {
    return new ProtonBridgeProvider(
      {
        provider: 'proton_bridge',
        emailAddress: account.emailAddress,
        displayName: account.displayName
      },
      genericCfg
    );
  }

  return new GenericImapSmtpProvider(genericCfg);
};
