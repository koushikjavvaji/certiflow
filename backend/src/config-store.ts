import type { Role, StepScope } from "@prisma/client";
import { prisma } from "./db";
import { redis } from "./redis";

// Rules live in the database (Setting, WorkflowStep) so they can change without a code
// change or redeploy. To keep reads cheap and every API/worker instance in agreement,
// they are cached in Redis for a short time:
//   - a manual edit in the database is picked up within CACHE_TTL_SECONDS;
//   - code that changes config can call invalidateConfigCache() for instant effect.
// If Redis is down we fall back to reading the database directly: slower, still correct.

export const CACHE_TTL_SECONDS = 15;
const SETTINGS_KEY = "cfg:settings";
const WORKFLOW_KEY = (version: number) => `cfg:workflow:${version}`;

export interface WorkflowStepConfig {
  position: number;
  key: string;
  name: string;
  role: Role;
  scope: StepScope;
  requiredApprovals: number;
  slaMinutes: number | null;
  condition: Record<string, unknown> | null;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* Redis unavailable: fall through to the database */
  }
  const value = await load();
  try {
    await redis.set(key, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch {
    /* cache is best-effort */
  }
  return value;
}

export function getAllSettings(): Promise<Record<string, unknown>> {
  return cached(SETTINGS_KEY, async () => {
    const rows = await prisma.setting.findMany({ select: { key: true, value: true }, orderBy: { key: "asc" } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const all = await getAllSettings();
  return key in all ? (all[key] as T) : fallback;
}

export function getWorkflow(version: number): Promise<WorkflowStepConfig[]> {
  return cached(WORKFLOW_KEY(version), async () => {
    const rows = await prisma.workflowStep.findMany({
      where: { workflowVersion: version },
      orderBy: { position: "asc" },
      select: {
        position: true,
        key: true,
        name: true,
        role: true,
        scope: true,
        requiredApprovals: true,
        slaMinutes: true,
        condition: true,
      },
    });
    return rows.map((r) => ({ ...r, condition: (r.condition as Record<string, unknown> | null) ?? null }));
  });
}

export async function getActiveWorkflow(): Promise<{ version: number; steps: WorkflowStepConfig[] }> {
  const version = await getSetting<number>("workflow.activeVersion", 1);
  return { version, steps: await getWorkflow(version) };
}

export async function invalidateConfigCache(): Promise<void> {
  const keys = await redis.keys("cfg:*");
  if (keys.length > 0) await redis.del(...keys);
}
