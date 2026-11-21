import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// Passwords are stored ONLY as scrypt hashes (a deliberately slow, memory-hungry function,
// so stolen hashes are expensive to crack). The parameters travel inside the stored string
// ("scrypt$N$r$p$salt$hash"), so they can be raised later and old hashes still verify.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024; // scrypt needs ~128 * N * r bytes = 32 MiB here

const scrypt = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCallback(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

// A well-formed hash that matches no password. Checking against it when the email is
// unknown makes "no such account" take as long as "wrong password", so the response time
// does not reveal which emails exist.
const NO_ACCOUNT = ["scrypt", N, R, P, Buffer.alloc(16).toString("base64"), Buffer.alloc(KEY_LENGTH, 1).toString("base64")].join("$");

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const hash = stored ?? NO_ACCOUNT;
  const [scheme, n, r, p, salt, key] = hash.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  try {
    const actual = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected) && stored !== null;
  } catch {
    return false;
  }
}
