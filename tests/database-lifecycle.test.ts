import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/db/database.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('database lifecycle', () => {
  it('supports one-shot migrations and readiness without mutating on server open', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slab-email-db-'));
    directories.push(directory);
    const database = new DatabaseService(join(directory, 'email.db'), { migrate: false });
    try {
      expect(database.getMigrationStatus()).toEqual({
        ready: false,
        expected: [1, 2],
        applied: [],
        pending: [1, 2]
      });
      database.migrate();
      expect(database.getMigrationStatus()).toEqual({
        ready: true,
        expected: [1, 2],
        applied: [1, 2],
        pending: []
      });
      database.migrate();
      expect(database.getMigrationStatus().applied).toEqual([1, 2]);
    } finally {
      database.close();
    }
  });
});
