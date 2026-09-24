import { randomBytes } from 'node:crypto';

/** Monotonic-ish, sortable, 26-char ULID-style identifier. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(): string {
  const time = Date.now();
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const randomness = randomBytes(16);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ULID_ALPHABET[randomness[i] % 32];
  }
  return timePart + randPart;
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}
