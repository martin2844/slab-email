import { GenericImapSmtpProvider } from '../imap-smtp/generic.js';
import { ProviderConnectionConfig } from '../types.js';
import type { GenericImapSmtpProviderConfig as GenericImapConfig } from '../imap-smtp/types.js';

export class ProtonBridgeProvider extends GenericImapSmtpProvider {
  constructor(
    private readonly baseConfig: ProviderConnectionConfig,
    private readonly connectionConfig: GenericImapConfig
  ) {
    super(connectionConfig);
  }

  getProviderType(): 'proton_bridge' {
    return 'proton_bridge';
  }

  getDisplayName() {
    return this.baseConfig.displayName ?? this.baseConfig.emailAddress;
  }
}
