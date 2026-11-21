import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config";

const ISSUER = "certiflow";
const TOKEN_TTL = "8h";

const claimsSchema = z.object({ sub: z.uuid() });

// The token carries ONLY the user id. Role and district are always re-read from the
// database on each request, so a token can never claim more than the user really has.
export function signToken(userId: string): string {
  return jwt.sign({}, config.jwtSecret, {
    algorithm: "HS256",
    issuer: ISSUER,
    subject: userId,
    expiresIn: TOKEN_TTL,
  });
}

// Returns the user id, or null for any problem (bad signature, expired, wrong
// algorithm, malformed claims). Callers treat null as "not authenticated".
export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER });
    const claims = claimsSchema.safeParse(decoded);
    return claims.success ? claims.data.sub : null;
  } catch {
    return null;
  }
}
