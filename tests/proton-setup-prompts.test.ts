import { describe, expect, it } from 'vitest';

import { hiddenInputLabel } from '../src/proton/setup-prompts.js';

describe('Proton setup prompts', () => {
  it('makes hidden terminal input and submission explicit', () => {
    expect(hiddenInputLabel('Proton password')).toBe(
      'Proton password (input hidden; type it and press Enter): '
    );
  });
});
