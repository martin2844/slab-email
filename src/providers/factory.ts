import { RuntimeConfig } from '../config/env.js';
import { AccountRecord, ImapSmtpAccountConfig } from '../types/models.js';
import { GenericImapSmtpProvider } from './imap-smtp/generic.js';
import type { GenericImapSmtpProviderConfig } from './imap-smtp/types.js';
import { GmailProvider } from './gmail/provider.js';
import { ProtonBridgeProvider } from './proton-bridge/provider.js';

export interface SecretBundle {
  username?: string;
  password?: string;
  refreshToken?: string;
}

const toGenericConfig = (account: AccountRecord, secret: SecretBundle): GenericImapSmtpProviderConfig => {
  const cfg = account.config as ImapSmtpAccountConfig;
  if (!cfg?.imapHost || !cfg?.smtpHost) {
    throw new Error('Missing IMAP/SMTP account configuration');
  }

  const username = secret.username || account.emailAddress;
  const password = secret.password;
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
      imapAllowInsecure: cfg.customTls
    },
    smtp: {
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpTlsMode: cfg.smtpTlsMode,
      smtpCustomCa: cfg.customCA,
      smtpAllowInsecure: cfg.customTls,
      fromName: account.displayName,
      fromAddress: account.emailAddress,
      smtpMessageIdDomain: cfg.smtpMessageIdDomain,
      username,
      password
    }
  };
};

export const createProvider = (account: AccountRecord, secret: SecretBundle, runtimeConfig: RuntimeConfig) => {
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
