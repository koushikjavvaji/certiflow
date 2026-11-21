import { Router } from "express";
import { z } from "zod";
import { authenticate, signToken, verifyPassword } from "../auth";
import { Handler, HttpError, chainOf } from "../chain";
import { config } from "../config";
import { prisma } from "../db";
import { allow, reset } from "../redis";

// ============ SIGN-IN as a chain: rate limit → find the person → check the password → hand out a token ============
interface LoginContext {
  email: string;
  password: string;
  ip: string | undefined;
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
  user?: { id: string; passwordHash: string | null } | null;
  token?: string;
}

const LOGIN_ATTEMPTS_PER_IP_PER_MINUTE = 30;
const ONE_MINUTE = 60;
const TEN_MINUTES = 600;
const prefix = `${config.queuePrefix}:rl:login`;
const emailKey = (email: string) => `${prefix}:email:${email}`;

// Brute-force protection: limited per caller AND per email address (so spreading guesses
// across many IPs does not help). The counter goes up BEFORE the password is checked (so
// parallel guesses cannot slip past a check-then-count gap); a correct sign-in clears it.
class RateLimit extends Handler<LoginContext> {
  protected async process(c: LoginContext) {
    const within =
      (await allow(`${prefix}:ip:${c.ip}`, LOGIN_ATTEMPTS_PER_IP_PER_MINUTE, ONE_MINUTE)) &&
      (await allow(emailKey(c.email), config.loginAttemptsPer10Min, TEN_MINUTES));
    if (!within) {
      c.log.warn({ email: c.email }, "login rate limit hit");
      throw new HttpError(429, "too many sign-in attempts, please wait a few minutes");
    }
    return false;
  }
}

class FindUser extends Handler<LoginContext> {
  protected async process(c: LoginContext) {
    c.user = await prisma.user.findFirst({ where: { email: c.email }, select: { id: true, passwordHash: true } });
    return false; // an unknown email does NOT stop here: the next step must cost the same time
  }
}

// Same answer and same cost whether the email exists or not, so nobody can find out which emails exist.
class CheckPassword extends Handler<LoginContext> {
  protected async process(c: LoginContext) {
    const ok = await verifyPassword(c.password, c.user?.passwordHash ?? null);
    if (!c.user || !ok) {
      c.log.warn({ email: c.email }, "failed sign-in");
      throw new HttpError(401, "invalid email or password");
    }
    return false;
  }
}

class IssueToken extends Handler<LoginContext> {
  protected async process(c: LoginContext) {
    const user = c.user as { id: string };
    await reset(emailKey(c.email)); // typos before this must not count towards a lockout
    c.log.info({ userId: user.id }, "signed in");
    c.token = signToken(user.id);
    return true;
  }
}

const loginChain = chainOf<LoginContext>(new RateLimit(), new FindUser(), new CheckPassword(), new IssueToken());

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

    const context: LoginContext = { email, password, ip: req.ip, log: req.log };
    await loginChain.handle(context);
    res.json({ token: context.token });
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
