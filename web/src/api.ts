// Tiny API client. The token lives in sessionStorage (cleared when the tab closes).
const TOKEN_KEY = "certiflow.token";

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export interface DemoUser {
  id: string;
  name: string;
  role: string;
  district: { name: string } | null;
  centre: { name: string } | null;
}
export interface Me {
  id: string;
  name: string;
  role: string;
  districtId: string | null;
  centreId: string | null;
}
export interface WorkflowStep {
  position: number;
  key: string;
  name: string;
  role: string;
  scope: string;
  requiredApprovals: number;
  slaMinutes: number | null;
  condition: Record<string, unknown> | null;
}
export interface ConfigView {
  settings: Record<string, unknown>;
  workflow: { version: number; steps: WorkflowStep[] };
}
