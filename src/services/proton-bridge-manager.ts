import { ApiError, ERROR_CODES } from '../types/errors.js';
import type { AccountRecord, ImapSmtpAccountConfig } from '../types/models.js';
import type { AccountService } from './account-service.js';

export type ProtonBridgeChallengeType =
  | 'two_factor'
  | 'mailbox_password'
  | 'human_verification';

export type ProtonBridgeMailbox = {
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapTlsMode: 'ssl' | 'starttls';
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: 'ssl' | 'starttls';
  username: string;
  bridgePassword: string;
};

type ProtonBridgeDiscoveredAddresses = {
  state: 'addresses';
  mode: 'combined' | 'split';
  mailboxes: ProtonBridgeMailbox[];
};

export type ProtonBridgeControllerResult =
  | {
      state: 'ready' | 'starting' | 'error';
      message?: string;
      accounts?: Array<{ emailAddress: string; state: string }>;
    }
  | {
      state: 'challenge_required';
      challengeId: string;
      challengeType: ProtonBridgeChallengeType;
      expiresAt: string;
      verificationUrl?: string;
    }
  | { state: 'connected'; mailbox: ProtonBridgeMailbox }
  | ProtonBridgeDiscoveredAddresses
  | { state: 'removed'; emailAddress: string }
  | { state: 'aborted' };

export interface ProtonBridgeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(
    action: string,
    input?: Record<string, unknown>
  ): Promise<ProtonBridgeControllerResult>;
}

export type ManagedProtonBridgeStatus = {
  available: boolean;
  version: string | null;
  state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'error';
  message?: string;
  accounts: Array<{ emailAddress: string; state: string }>;
};

export type ManagedProtonSetupResult =
  | {
      state: 'challenge_required';
      challengeId: string;
      challengeType: ProtonBridgeChallengeType;
      expiresAt: string;
      verificationUrl?: string;
    }
  | { state: 'connected'; account: AccountRecord };

export type ManagedProtonAddressSyncResult = {
  mode: 'combined' | 'split';
  accounts: AccountRecord[];
};

type ManagedProtonBridgeDependencies = {
  controller: ProtonBridgeController;
  accountService: AccountService;
  available: boolean;
  version: string | null;
};

type PendingSetup = {
  emailAddress: string;
  displayName: string;
  expiresAt: number;
};

export class ManagedProtonBridge {
  private started = false;
  private readonly pending = new Map<string, PendingSetup>();

  constructor(private readonly deps: ManagedProtonBridgeDependencies) {}

  async status(): Promise<ManagedProtonBridgeStatus> {
    if (!this.deps.available) {
      return {
        available: false,
        version: this.deps.version,
        state: 'unavailable',
        message: 'Managed Proton Bridge is not available for this platform.',
        accounts: []
      };
    }
    if (!this.started) {
      const accounts = this.deps.accountService.listAccounts()
        .filter(
          (account) =>
            account.provider === 'proton_bridge' &&
            'managedBridge' in account.config &&
            account.config.managedBridge === true
        )
        .map((account) => ({ emailAddress: account.emailAddress, state: 'stopped' }));
      return {
        available: true,
        version: this.deps.version,
        state: 'stopped',
        accounts
      };
    }
    try {
      const result = await this.deps.controller.request('status');
      if (result.state !== 'ready' && result.state !== 'starting' && result.state !== 'error') {
        throw new Error('Unexpected Proton Bridge status response');
      }
      return {
        available: true,
        version: this.deps.version,
        state: result.state,
        message: result.message,
        accounts: result.accounts ?? []
      };
    } catch (error) {
      return {
        available: true,
        version: this.deps.version,
        state: 'error',
        message: safeMessage(error),
        accounts: []
      };
    }
  }

  async connect(input: {
    emailAddress: string;
    displayName: string;
    password: string;
  }): Promise<ManagedProtonSetupResult> {
    this.assertAvailable();
    await this.ensureStarted();
    const result = await this.callController('connect', {
      emailAddress: input.emailAddress,
      password: input.password
    });
    return this.handleSetupResult(result, {
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
  }

  async continueLogin(input: {
    challengeId: string;
    value?: string;
  }): Promise<ManagedProtonSetupResult> {
    this.assertAvailable();
    const pending = this.pending.get(input.challengeId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(input.challengeId);
      throw new ApiError(ERROR_CODES.STATE_EXPIRED, 'Proton Bridge setup session expired', 409);
    }
    await this.ensureStarted();
    const result = await this.callController('challenge', {
      challengeId: input.challengeId,
      value: input.value ?? ''
    });
    return this.handleSetupResult(result, pending);
  }

  async abort(challengeId: string): Promise<void> {
    if (!this.deps.available || !this.started) return;
    await this.callController('abort', { challengeId });
    this.pending.delete(challengeId);
  }

  async remove(emailAddress: string): Promise<void> {
    this.assertAvailable();
    await this.ensureStarted();
    await this.callController('remove', { emailAddress });
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const account = this.deps.accountService.getAccount(accountId);
    if (
      account.provider !== 'proton_bridge' ||
      !('managedBridge' in account.config) ||
      account.config.managedBridge !== true
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_INPUT,
        'Account is not managed by the embedded Proton Bridge.',
        409
      );
    }
    const config = account.config as ImapSmtpAccountConfig;
    const login = config.managedBridgeLogin ?? account.emailAddress;
    const group = this.deps.accountService.listAccounts().filter((candidate) =>
      candidate.provider === 'proton_bridge' &&
      (candidate.config as ImapSmtpAccountConfig).managedBridge === true &&
      ((candidate.config as ImapSmtpAccountConfig).managedBridgeLogin ?? candidate.emailAddress).toLowerCase() ===
        login.toLowerCase()
    );
    const impacted =
      account.emailAddress.toLowerCase() === login.toLowerCase()
        ? group
        : [account];
    const assigned = impacted.filter(({ id }) =>
      this.deps.accountService.isAccountAssigned(id)
    );
    if (assigned.length > 0) {
      throw new ApiError(
        ERROR_CODES.ACCOUNT_IN_USE,
        'Remove every affected Proton sender from access profiles before deleting it.',
        409,
        { accounts: assigned.map(({ id, emailAddress }) => ({ id, emailAddress })) }
      );
    }
    if (account.emailAddress.toLowerCase() !== login.toLowerCase()) {
      this.deps.accountService.deleteAccount(accountId);
      return;
    }
    await this.remove(login);
    const assignedAfterRemoval = group.filter(({ id }) =>
      this.deps.accountService.isAccountAssigned(id)
    );
    if (assignedAfterRemoval.length > 0) {
      throw new ApiError(
        ERROR_CODES.ACCOUNT_IN_USE,
        'Proton Bridge signed out, but local sender records were preserved because an access profile changed during deletion. Remove the assignments, then delete or reconnect the account.',
        409,
        { accounts: assignedAfterRemoval.map(({ id, emailAddress }) => ({ id, emailAddress })) }
      );
    }
    for (const candidate of group) {
      this.deps.accountService.deleteAccount(candidate.id);
    }
  }

  async syncAddresses(accountId: string): Promise<ManagedProtonAddressSyncResult> {
    this.assertAvailable();
    const account = this.deps.accountService.getAccount(accountId);
    if (
      account.provider !== 'proton_bridge' ||
      (account.config as ImapSmtpAccountConfig).managedBridge !== true
    ) {
      throw new ApiError(
        ERROR_CODES.INVALID_INPUT,
        'Account is not managed by the embedded Proton Bridge.',
        409
      );
    }
    await this.ensureStarted();
    const config = account.config as ImapSmtpAccountConfig;
    const login = config.managedBridgeLogin ?? account.emailAddress;
    const result = await this.callController('addresses', {
      emailAddress: login,
      enableSplit: true
    });
    if (result.state !== 'addresses') {
      throw new ApiError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        'Proton Bridge did not return sender addresses.',
        502
      );
    }
    const allAccounts = this.deps.accountService.listAccounts();
    const existing = new Map(
      allAccounts
        .filter((candidate) =>
          candidate.provider === 'proton_bridge' &&
          (candidate.config as ImapSmtpAccountConfig).managedBridge === true &&
          ((candidate.config as ImapSmtpAccountConfig).managedBridgeLogin ?? candidate.emailAddress).toLowerCase() ===
            login.toLowerCase()
        )
        .map((candidate) => [candidate.emailAddress.toLowerCase(), candidate])
    );
    const returnedAddresses = new Set(
      result.mailboxes.map(({ emailAddress }) => emailAddress.toLowerCase())
    );
    const stale = allAccounts.filter((candidate) =>
      candidate.provider === 'proton_bridge' &&
      (candidate.config as ImapSmtpAccountConfig).managedBridge === true &&
      ((candidate.config as ImapSmtpAccountConfig).managedBridgeLogin ?? candidate.emailAddress).toLowerCase() ===
        login.toLowerCase() &&
      !returnedAddresses.has(candidate.emailAddress.toLowerCase())
    );
    const accounts = result.mailboxes.map((mailbox) => {
      const previous = existing.get(mailbox.emailAddress.toLowerCase());
      return this.deps.accountService.upsertManagedProtonBridgeAccount({
        emailAddress: mailbox.emailAddress,
        displayName: previous?.displayName ?? mailbox.emailAddress,
        imapHost: mailbox.imapHost,
        imapPort: mailbox.imapPort,
        imapTlsMode: mailbox.imapTlsMode,
        smtpHost: mailbox.smtpHost,
        smtpPort: mailbox.smtpPort,
        smtpTlsMode: mailbox.smtpTlsMode,
        username: mailbox.username,
        password: mailbox.bridgePassword,
        customTls: true,
        managedBridgeLogin: login
      });
    });
    const assignedStale = stale.filter(({ id }) =>
      this.deps.accountService.isAccountAssigned(id)
    );
    const assignedStaleIds = new Set(assignedStale.map(({ id }) => id));
    for (const candidate of stale) {
      if (assignedStaleIds.has(candidate.id)) {
        this.deps.accountService.setEnabled(candidate.id, false);
      } else {
        this.deps.accountService.deleteAccount(candidate.id);
      }
    }
    if (assignedStale.length > 0) {
      throw new ApiError(
        ERROR_CODES.ACCOUNT_IN_USE,
        'A Proton sender removed upstream was disabled locally because it is still assigned to an access profile.',
        409,
        { accounts: assignedStale.map(({ id, emailAddress }) => ({ id, emailAddress })) }
      );
    }
    return { mode: result.mode, accounts };
  }

  async startIfConfigured(): Promise<void> {
    if (!this.deps.available) return;
    const configured = this.deps.accountService.listAccounts().some(
      (account) =>
        account.provider === 'proton_bridge' &&
        'managedBridge' in account.config &&
        account.config.managedBridge === true
    );
    if (configured) await this.ensureStarted();
  }

  async shutdown(): Promise<void> {
    this.started = false;
    this.pending.clear();
    await this.deps.controller.stop();
  }

  private handleSetupResult(
    result: ProtonBridgeControllerResult,
    setup: PendingSetup
  ): ManagedProtonSetupResult {
    if (result.state === 'challenge_required') {
      this.pending.set(result.challengeId, {
        ...setup,
        expiresAt: Date.parse(result.expiresAt)
      });
      return result;
    }
    if (result.state !== 'connected') {
      throw new ApiError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        'Proton Bridge did not complete the account connection',
        502
      );
    }
    for (const [challengeId, pending] of this.pending) {
      if (pending.emailAddress === setup.emailAddress) this.pending.delete(challengeId);
    }
    const mailbox = result.mailbox;
    const account = this.deps.accountService.upsertManagedProtonBridgeAccount({
      emailAddress: mailbox.emailAddress,
      displayName: setup.displayName,
      imapHost: mailbox.imapHost,
      imapPort: mailbox.imapPort,
      imapTlsMode: mailbox.imapTlsMode,
      smtpHost: mailbox.smtpHost,
      smtpPort: mailbox.smtpPort,
      smtpTlsMode: mailbox.smtpTlsMode,
      username: mailbox.username,
      password: mailbox.bridgePassword,
      customTls: true,
      managedBridgeLogin: setup.emailAddress
    });
    return { state: 'connected', account };
  }

  private assertAvailable(): void {
    if (this.deps.available) return;
    throw new ApiError(
      ERROR_CODES.INVALID_CONFIGURATION,
      'Managed Proton Bridge is not available for this platform.',
      409
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.deps.controller.start();
    this.started = true;
  }

  private async callController(
    action: string,
    input?: Record<string, unknown>
  ): Promise<ProtonBridgeControllerResult> {
    try {
      return await this.deps.controller.request(action, input);
    } catch (error) {
      const message = safeMessage(error);
      if (message.startsWith('AUTH_FAILED:')) {
        throw new ApiError(ERROR_CODES.AUTH_REQUIRED, 'Proton rejected the account login.', 401);
      }
      if (message.startsWith('STATE_EXPIRED:')) {
        throw new ApiError(ERROR_CODES.STATE_EXPIRED, 'Proton Bridge setup session expired.', 409);
      }
      if (message.startsWith('STATE_INVALID:')) {
        throw new ApiError(ERROR_CODES.STATE_INVALID, 'Proton Bridge setup session is not active.', 409);
      }
      if (message.startsWith('INVALID_INPUT:')) {
        throw new ApiError(ERROR_CODES.INVALID_INPUT, 'Invalid Proton Bridge setup input.', 400);
      }
      throw new ApiError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        'Managed Proton Bridge is unavailable. Check its status and retry.',
        503
      );
    }
  }
}

const safeMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Managed Proton Bridge failed.';
  const message = error.message.replace(/[\r\n\t]+/g, ' ').trim();
  return message.slice(0, 300) || 'Managed Proton Bridge failed.';
};
