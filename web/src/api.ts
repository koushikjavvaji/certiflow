// Tiny API client. The token lives in sessionStorage (cleared when the tab closes).
const TOKEN_KEY = "certiflow.token";

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
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
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText, body);
  return body as T;
}

export const post = <T>(path: string, body: object = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: object) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

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

export type View = "waiting" | "all" | "stuck";

export interface BatchSummary {
  id: string;
  courseName: string;
  centreName: string;
  status: string;
  candidateCount: number;
  stepName: string | null;
  approvalsHave: number;
  approvalsNeed: number | null;
  overdue: boolean;
  lastReason: string | null;
  waitingForMe: boolean;
  updatedAt: string;
}

export interface BatchDetail {
  batch: {
    id: string;
    courseName: string;
    centreName: string;
    status: string;
    version: number;
    candidateCount: number;
    lastReason: string | null;
    overdue: boolean;
    stepKey: string | null;
    stepName: string | null;
    approvalsNeed: number | null;
  };
  approvals: { officer: string; at: string }[];
  candidates: { id: string; name: string; phone: string; courseCode: string; marks: number | null }[];
  certificates: {
    id: string;
    number: string;
    holder: string;
    status: string;
    deliveryStatus: string;
    attempts: number;
    cancelReason: string | null;
    verifyCode?: string;
  }[];
  audit: {
    id: string;
    at: string;
    actor: string;
    action: string;
    reason: string | null;
    correlationId: string | null;
  }[];
  actions: string[];
}

export interface RowError {
  row: number;
  field?: string;
  message: string;
}

// Downloads a file that needs the login token (a plain link cannot send it): fetch it with
// the Authorization header, then hand the bytes to the browser as a normal download.
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText, body);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
