export type TlsMode = 'ssl' | 'starttls' | 'none';

export interface ImapConfig {
  imapHost: string;
  imapPort: number;
  imapTlsMode: TlsMode;
  username: string;
  password: string;
  imapCustomCa?: string;
  imapAllowInsecure?: boolean;
}

export interface SmtpConfig {
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: TlsMode;
  smtpCustomCa?: string;
  smtpAllowInsecure?: boolean;
  fromName?: string;
  fromAddress: string;
  smtpMessageIdDomain?: string;
  username: string;
  password: string;
}

export interface GenericImapSmtpProviderConfig {
  emailAddress: string;
  displayName: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
}
