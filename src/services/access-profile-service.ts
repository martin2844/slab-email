import { randomUUID } from 'node:crypto';

import { ApiError, ERROR_CODES } from '../types/errors.js';
import { AccessProfile, AccessProfileWithAccounts } from '../types/models.js';
import { hashText } from '../config/env.js';
import { DatabaseService } from '../db/database.js';

export interface AccessProfileInput {
  name: string;
  readEnabled: boolean;
  draftEnabled: boolean;
  sendEnabled: boolean;
  accountIds: string[];
}

const sanitizeName = (name: string): string => name.trim();

export class AccessProfileService {
  constructor(private readonly db: DatabaseService) {}

  list(): AccessProfileWithAccounts[] {
    return this.db.listProfiles();
  }

  get(id: string): AccessProfileWithAccounts {
    const profile = this.db.getProfile(id);
    if (!profile) {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, `Profile ${id} not found`, 404);
    }
    return profile;
  }

  create(input: AccessProfileInput): AccessProfile {
    const id = randomUUID();
    const profile = {
      id,
      name: sanitizeName(input.name),
      readEnabled: input.readEnabled,
      draftEnabled: input.draftEnabled,
      sendEnabled: input.sendEnabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountIds: input.accountIds
    };

    this.db.createProfile(profile);
    this.db.setProfileAccounts(id, input.accountIds);
    return profile;
  }

  update(id: string, input: AccessProfileInput): AccessProfile {
    const existing = this.get(id);
    const next = {
      ...existing,
      name: sanitizeName(input.name),
      readEnabled: input.readEnabled,
      draftEnabled: input.draftEnabled,
      sendEnabled: input.sendEnabled,
      updatedAt: new Date().toISOString()
    };

    this.db.updateProfile({
      id,
      name: next.name,
      readEnabled: next.readEnabled,
      draftEnabled: next.draftEnabled,
      sendEnabled: next.sendEnabled,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      accountIds: input.accountIds
    });

    return next;
  }

  remove(id: string): void {
    this.get(id);
    this.db.deleteProfile(id);
  }

  listTokens(profileId: string): Array<{
    id: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }> {
    const profile = this.get(profileId);
    if (!profile) {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, `Profile ${profileId} not found`, 404);
    }
    return this.db.listAccessTokens(profile.id);
  }

  createToken(profileId: string): { token: string; id: string; prefix: string } {
    const profile = this.get(profileId);
    if (!profile) {
      throw new ApiError(ERROR_CODES.INVALID_INPUT, `Profile ${profileId} not found`, 404);
    }

    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
    const tokenId = randomUUID();

    this.db.createAccessToken({
      id: tokenId,
      profileId: profile.id,
      tokenHash: hashText(token),
      tokenPrefix: token.slice(0, 8)
    });

    return {
      token,
      id: tokenId,
      prefix: token.slice(0, 8)
    };
  }

  revokeToken(profileId: string, tokenId: string): void {
    this.get(profileId);
    this.db.revokeAccessToken(profileId, tokenId);
  }

  rotateToken(profileId: string, previousTokenId?: string): { token: string; id: string; prefix: string } {
    if (previousTokenId) {
      this.revokeToken(profileId, previousTokenId);
    }
    return this.createToken(profileId);
  }
}
