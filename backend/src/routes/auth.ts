import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { signToken } from "../auth";
import { authenticate } from "../middleware/authenticate";

// --- Demo-only "switch user" login -------------------------------------------------
// The brief wants reviewers to hop between people with no passwords. The two demo
// routes are only mounted when demoMode is true; with it off they simply do not exist
// (404). demoMode is a parameter (not read at import time) so tests can build both.
export function createAuthRouter(demoMode: boolean) {
  const router = Router();

  if (demoMode) {
    router.get("/auth/demo-users", async (_req, res) => {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          role: true,
          district: { select: { name: true } },
          centre: { select: { name: true } },
        },
        orderBy: { name: "asc" },
      });
      res.json({ users });
    });

    const loginBody = z.object({ userId: z.uuid() });

    router.post("/auth/demo-login", async (req, res) => {
      const { userId } = loginBody.parse(req.body);
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        res.status(404).json({ error: "unknown user" });
        return;
      }
      res.json({ token: signToken(user.id) });
    });
  }

  // Who am I? Identity comes from the verified token, never from anything the client sends.
  router.get("/me", authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
