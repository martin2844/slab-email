import { describe, expect, it } from 'vitest';

import { hiddenInputLabel, withPausedInput } from '../src/proton/setup-prompts.js';

describe('Proton setup prompts', () => {
  it('makes hidden terminal input and submission explicit', () => {
    expect(hiddenInputLabel('Proton password')).toBe(
      'Proton password (input hidden; type it and press Enter): '
    );
  });

  it('pauses the active readline consumer while secret input owns the TTY', () => {
    const events: string[] = [];
    const input = {
      pause: () => events.push('pause'),
      resume: () => events.push('resume')
    };

    const result = withPausedInput(input, () => {
      events.push('read');
      return 'secret';
    });

    expect(result).toBe('secret');
    expect(events).toEqual(['pause', 'read', 'resume']);
  });

  it('resumes readline when hidden input fails', () => {
    const events: string[] = [];
    const input = {
      pause: () => events.push('pause'),
      resume: () => events.push('resume')
    };

    expect(() =>
      withPausedInput(input, () => {
        events.push('read');
        throw new Error('read failed');
      })
    ).toThrow('read failed');
    expect(events).toEqual(['pause', 'read', 'resume']);
  });
});
