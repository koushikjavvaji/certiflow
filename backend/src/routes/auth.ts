import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { signToken } from "../auth";
import { verifyPassword } from "../password";
import { allow } from "../rate-limit";
import { authenticate } from "../middleware/authenticate";

// --- Demo-only "switch user" login -------------------------------------------------
// The brief wants reviewers to hop between people with no passwords. The two demo
// routes are only mounted when demoMode is true; with it off they simply do not exist
// (404). demoMode is a parameter (not read at import time) so tests can build both.
export function createAuthRouter(demoMode: boolean) {
  const router = Router();

  // Tells the web app which sign-in screen to show.
  router.get("/auth/config", (_req, res) => {
    res.json({ demoMode });
  });

  // --- Real sign-in: email + password ------------------------------------------------
  const credentials = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().min(1).max(200),
  });

  router.post("/auth/login", async (req, res) => {
    const { email, password } = credentials.parse(req.body);

    // Brute-force protection: limited per caller AND per email address (so spreading
    // guesses across many IPs does not help). Counted in Redis, shared by all instances.
    const prefix = `${config.queuePrefix}:rl:login`;
    const within = (await allow(`${prefix}:ip:${req.ip}`, 30, 60)) && (await allow(`${prefix}:email:${email}`, config.loginAttemptsPer10Min, 600));
    if (!within) {
      req.log.warn({ email }, "login rate limit hit");
      res.status(429).json({ error: "too many sign-in attempts, please wait a few minutes" });
      return;
    }

    const user = await prisma.user.findFirst({ where: { email }, select: { id: true, passwordHash: true } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) {
      // Same answer and same cost whether the email exists or not.
      req.log.warn({ email }, "failed sign-in");
      res.status(401).json({ error: "invalid email or password" });
      return;
    }
    req.log.info({ userId: user.id }, "signed in");
    res.json({ token: signToken(user.id) });
  });

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
