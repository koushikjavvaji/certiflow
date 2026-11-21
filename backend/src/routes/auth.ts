import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { signToken } from "../auth";
import { authenticate } from "../middleware/authenticate";

export const authRouter = Router();

// --- Demo-only "switch user" login -------------------------------------------------
// The brief wants reviewers to hop between people with no passwords. This is only
// mounted when DEMO_MODE=true; with it off these routes simply do not exist (404).
if (config.demoMode) {
  authRouter.get("/auth/demo-users", async (_req, res) => {
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

  authRouter.post("/auth/demo-login", async (req, res) => {
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
authRouter.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});
