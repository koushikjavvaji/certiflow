import { Router } from "express";
import { getActiveWorkflow, getAllSettings } from "../config-store";
import { authenticate } from "../middleware/authenticate";

export const configRouter = Router();

// Read-only view of the live rules (settings + approval path). Any logged-in user may
// look; changing them is done in the database (an admin screen is a future step, and
// it will write to the audit log).
configRouter.get("/config", authenticate, async (_req, res) => {
  const [settings, workflow] = await Promise.all([getAllSettings(), getActiveWorkflow()]);
  res.json({ settings, workflow });
});
