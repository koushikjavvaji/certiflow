import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { verifyToken } from "../auth";
import { prisma } from "../db";

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
