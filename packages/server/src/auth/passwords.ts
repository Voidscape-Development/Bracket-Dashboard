/**
 * Password hashing.
 *
 * scrypt from node:crypto rather than a native bcrypt/argon2 dependency: this
 * app ships inside Electron, and every native module is one more thing to
 * rebuild per platform. scrypt with these parameters is a sound choice for
 * local accounts guarding a venue LAN.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] as string, 'hex');
  const expected = Buffer.from(parts[2] as string, 'hex');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return timingSafeEqual(derived, expected);
}

const WORDS = [
  'bracket', 'pool', 'finals', 'upset', 'reset', 'seed', 'station', 'stream',
  'match', 'round', 'entrant', 'winner', 'loser', 'grand', 'clutch', 'combo',
];

/**
 * Readable first-run password: someone has to type this off a screen at a
 * venue, so entropy comes from length rather than punctuation.
 */
export function generatePassword(): string {
  const pick = () => WORDS[randomInt(WORDS.length)] as string;
  return `${pick()}-${pick()}-${pick()}-${randomInt(100, 1000)}`;
}
