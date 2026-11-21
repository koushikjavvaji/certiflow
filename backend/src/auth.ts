import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import jwt from "jsonwebtoken";

// Everything about WHO YOU ARE, in one place:
//   1. login tokens        2. password hashing        3. the "who is calling?" middleware

// ============================ 1. Login tokens ============================
const ISSUER = "certiflow";
const TOKEN_TTL = "8h";
const claimsSchema = z.object({ sub: z.uuid() });

// The token carries ONLY the user id. Role and district are always re-read from the
// database on each request, so a token can never claim more than the user really has.
export function signToken(userId: string): string {
  return jwt.sign({}, config.jwtSecret, { algorithm: "HS256", issuer: ISSUER, subject: userId, expiresIn: TOKEN_TTL });
}

// Returns the user id, or null for any problem (bad signature, expired, wrong algorithm,
// malformed claims). Callers treat null as "not authenticated".
export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER });
    const claims = claimsSchema.safeParse(decoded);
    return claims.success ? claims.data.sub : null;
  } catch {
    return null;
  }
}

// ============================ 2. Passwords ============================
// Stored ONLY as scrypt hashes (deliberately slow and memory-hungry, so stolen hashes are
// expensive to crack). The parameters travel inside the stored string
// ("scrypt$N$r$p$salt$hash"), so they can be raised later and old hashes still verify.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024; // scrypt needs ~128 * N * r bytes = 32 MiB here

const scrypt = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCallback(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

// A well-formed hash that matches no password. Checking against it when the email is
// unknown makes "no such account" take as long as "wrong password", so the response time
// does not reveal which emails exist.
const NO_ACCOUNT = [
  "scrypt",
  N,
  R,
  P,
  Buffer.alloc(16).toString("base64"),
  Buffer.alloc(KEY_LENGTH, 1).toString("base64"),
].join("$");

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = (stored ?? NO_ACCOUNT).split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  try {
    const actual = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected) && stored !== null;
  } catch {
    return false;
  }
}

// ============================ 3. "Who is calling?" middleware ============================
export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  districtId: string | null;
  centreId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  // Soft-deleted users are invisible here, so deleting a user also kills their tokens.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, districtId: true, centreId: true },
  });
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  req.user = user;
  next();
}

// Use after authenticate(). Enforced on the server for every route that needs it;
// hiding buttons in the UI is never the security boundary.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
