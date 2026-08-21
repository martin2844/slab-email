import { describe, expect, it } from 'vitest';

import { hiddenInputLabel } from '../src/proton/setup-prompts.js';
import { terminalQuestion } from '../src/proton/terminal-question.js';

describe('Proton setup prompts', () => {
  it('makes hidden terminal input and submission explicit', () => {
    expect(hiddenInputLabel('Proton password')).toBe(
      'Proton password (input hidden; type it and press Enter): '
    );
  });

  it('uses one terminal reader for visible and hidden questions', () => {
    const events: string[] = [];
    const dependencies = {
      isTTY: true,
      execute: (script: string, label: string) => {
        events.push(
          `${script.includes('stty -echo') ? 'read:hidden' : 'read:visible'}:${label}`
        );
        return 'answer';
      }
    };

    expect(terminalQuestion('Email: ', false, dependencies)).toBe('answer');
    expect(terminalQuestion('Password: ', true, dependencies)).toBe('answer');
    expect(events).toEqual([
      'read:visible:Email: ',
      'read:hidden:Password: '
    ]);
  });

  it('disables echo before rendering a hidden prompt', () => {
    let script = '';
    terminalQuestion('Password: ', true, {
      isTTY: true,
      execute: (value) => {
        script = value;
        return 'secret';
      }
    });

    expect(script.indexOf('stty -echo')).toBeLessThan(script.indexOf("printf '%s'"));
  });

  it('rejects interactive questions without a TTY', () => {
    expect(() =>
      terminalQuestion('Password: ', true, {
        isTTY: false,
        execute: () => 'secret'
      })
    ).toThrow('A TTY is required');
  });
});
