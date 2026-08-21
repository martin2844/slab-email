export const hiddenInputLabel = (label: string): string =>
  `${label} (input hidden; type it and press Enter): `;

type PausableInput = {
  pause: () => unknown;
  resume: () => unknown;
};

export const withPausedInput = <T>(input: PausableInput, read: () => T): T => {
  input.pause();
  try {
    return read();
  } finally {
    input.resume();
  }
};
