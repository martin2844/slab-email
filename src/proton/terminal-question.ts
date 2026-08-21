import { execFileSync } from 'node:child_process';
import { stdin } from 'node:process';

type TerminalQuestionDependencies = {
  isTTY: boolean;
  execute: (script: string, label: string) => string;
};

const visibleRead = `printf '%s' "$1" >/dev/tty; IFS= read -r value </dev/tty; printf '%s' "$value"`;
const hiddenRead = `trap 'stty echo </dev/tty' EXIT HUP INT TERM; stty -echo </dev/tty; printf '%s' "$1" >/dev/tty; IFS= read -r value </dev/tty; printf '\n' >/dev/tty; printf '%s' "$value"`;

const defaultDependencies = (): TerminalQuestionDependencies => ({
  isTTY: Boolean(stdin.isTTY),
  execute: (script, label) =>
    execFileSync('/bin/sh', ['-c', script, 'slab-terminal-question', label], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
});

export const terminalQuestion = (
  label: string,
  hidden = false,
  dependencies = defaultDependencies()
): string => {
  if (!dependencies.isTTY) throw new Error('A TTY is required for interactive input.');
  return dependencies.execute(hidden ? hiddenRead : visibleRead, label);
};
