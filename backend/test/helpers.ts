import request from "supertest";
import { createApp } from "../src/app";
import { DEMO_USER_IDS } from "../src/seed";

export const app = createApp({ demoMode: true });
export { DEMO_USER_IDS };

export async function tokenFor(userId: string): Promise<string> {
  const res = await request(app).post("/auth/demo-login").send({ userId });
  if (res.status !== 200) throw new Error(`demo-login failed: ${res.status}`);
  return res.body.token as string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
