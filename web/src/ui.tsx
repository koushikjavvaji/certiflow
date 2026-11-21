import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { WorkflowStep } from "./api";

// Shared building blocks: labels, small components and the toast system. Kept in one file so the
// screens (Dashboard, BatchDetail, Verify, App) only contain screen logic.

// ============================ The product's name (change it here and nowhere else) ============================
// "Dhruva" (ధ్రువ) comes from the Telugu word ధ్రువపత్రం (dhruvapatram), a certificate. It also means
// "certain, unchanging, the pole star": exactly what a certificate should be.
export const BRAND = "Dhruva";
export const BRAND_TELUGU = "ధ్రువ";
export const TAGLINE = "Certificates you can trust";

// ============================ Labels ============================
export const ROLE_LABEL: Record<string, string> = {
  CENTRE: "Training centre",
  DISTRICT_OFFICER: "District officer",
  QUALITY: "Quality team",
  STATE: "State office",
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  CHANGES_REQUESTED: "Sent back",
  REJECTED: "Rejected",
  APPROVED: "Approved",
  ISSUING: "Issuing certificates",
  COMPLETED: "Completed",
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: "neutral",
  IN_REVIEW: "info",
  CHANGES_REQUESTED: "warn",
  REJECTED: "danger",
  APPROVED: "success",
  ISSUING: "accent",
  COMPLETED: "success",
};

export const ACTION_LABEL: Record<string, string> = {
  BATCH_CREATED: "Created the batch",
  CANDIDATES_UPLOADED: "Uploaded the candidates",
  BATCH_SUBMITTED: "Submitted for review",
  BATCH_RESUBMITTED: "Resubmitted after changes",
  STEP_APPROVED: "Approved",
  STEP_COMPLETED: "Step completed",
  APPROVAL_WITHDRAWN: "Withdrew an approval",
  BATCH_SENT_BACK: "Sent the batch back",
  BATCH_REJECTED: "Rejected the batch",
  BATCH_APPROVED: "Gave the final approval",
  ISSUANCE_STARTED: "Started issuing certificates",
  CERTIFICATE_ISSUED: "Certificate created",
  CERTIFICATE_DELIVERED: "Certificate delivered on WhatsApp",
  DELIVERY_FAILED: "Delivery gave up",
  CERTIFICATE_CANCELLED: "Cancelled a certificate",
  BATCH_OVERDUE: "Overdue: escalated to the state office",
  BATCH_COMPLETED: "All certificates handled",
};

export const when = (iso: string) => new Date(iso).toLocaleString();

export function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ============================ Icons (simple line icons) ============================
const ICONS = {
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  download: "M12 3v12m0 0-4-4m4 4 4-4M5 21h14",
  upload: "M12 15V3m0 0L8 7m4-4 4 4M5 21h14",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  plus: "M12 5v14M5 12h14",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2",
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// ============================ Small components ============================
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? "neutral"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Chip({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: string;
  icon?: keyof typeof ICONS;
  children: ReactNode;
}) {
  return (
    <span className={`chip ${tone}`}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function Progress({ value, max, tone, small }: { value: number; max: number; tone?: string; small?: boolean }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className={`progress ${tone ?? ""} ${small ? "sm" : ""}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function EmptyState({
  icon = "inbox",
  title,
  children,
}: {
  icon?: keyof typeof ICONS;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="icon">
        <Icon name={icon} size={22} />
      </div>
      <b>{title}</b>
      {children}
    </div>
  );
}

// ============================ The approval stepper ============================
// Draws the path a batch follows (Submitted → each step that applies to its size → Certificates)
// and where it is now. The steps come from the database rules, so a new step appears by itself.
export function Stepper({
  steps,
  count,
  currentKey,
  status,
  approvals,
  needed,
}: {
  steps: WorkflowStep[];
  count: number;
  currentKey: string | null;
  status: string;
  approvals: number;
  needed: number | null;
}) {
  const path = steps.filter((s) => {
    const min = s.condition?.minCandidates;
    return typeof min !== "number" || count >= min;
  });
  const finished = ["APPROVED", "ISSUING", "COMPLETED"].includes(status);
  const at = finished ? path.length : path.findIndex((s) => s.key === currentKey);

  type Node = { label: string; sub?: string; state: "done" | "current" | "pending" | "warn" | "danger" };
  const nodes: Node[] = [
    { label: status === "DRAFT" ? "Your draft" : "Submitted", state: status === "DRAFT" ? "current" : "done" },
  ];
  path.forEach((s, i) => {
    let state: Node["state"] = "pending";
    if (status !== "DRAFT") {
      if (finished || i < at) state = "done";
      else if (i === at) state = status === "REJECTED" ? "danger" : status === "CHANGES_REQUESTED" ? "warn" : "current";
    }
    const sub =
      i === at && status === "IN_REVIEW" && needed
        ? `${approvals} of ${needed}`
        : s.requiredApprovals > 1
          ? `${s.requiredApprovals} approvals`
          : undefined;
    nodes.push({ label: s.name.replace(/\s*\(.*\)$/, ""), sub, state });
  });
  nodes.push({
    label: "Certificates",
    sub: status === "ISSUING" ? "being sent" : undefined,
    state: status === "COMPLETED" ? "done" : status === "ISSUING" || status === "APPROVED" ? "current" : "pending",
  });

  return (
    <ol className="stepper" aria-label="Approval path">
      {nodes.map((n, i) => (
        <li key={i} className={n.state}>
          <div className="dot">
            {n.state === "done" ? (
              <Icon name="check" size={16} />
            ) : n.state === "danger" ? (
              <Icon name="x" size={16} />
            ) : (
              i + 1
            )}
          </div>
          <div className="label">{n.label}</div>
          {n.sub && <div className="sub">{n.sub}</div>}
        </li>
      ))}
    </ol>
  );
}

// ============================ Toasts (small messages that fade away) ============================
type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: ToastKind = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === "error" ? "alert" : "check"} size={18} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
