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

export const ACTION_LABEL: Record<string, string> = {
  BATCH_CREATED: "Batch created",
  CANDIDATES_UPLOADED: "Candidates uploaded",
  BATCH_SUBMITTED: "Submitted for review",
  BATCH_RESUBMITTED: "Resubmitted after changes",
  STEP_APPROVED: "Approved",
  STEP_COMPLETED: "Step completed",
  APPROVAL_WITHDRAWN: "Approval withdrawn",
  BATCH_SENT_BACK: "Sent back",
  BATCH_REJECTED: "Rejected",
  BATCH_APPROVED: "Final approval",
  ISSUANCE_STARTED: "Issuing started",
  CERTIFICATE_ISSUED: "Certificate issued",
  CERTIFICATE_DELIVERED: "Certificate delivered on WhatsApp",
  DELIVERY_FAILED: "Delivery gave up",
  CERTIFICATE_CANCELLED: "Certificate cancelled",
  BATCH_OVERDUE: "Overdue: escalated to the state office",
  BATCH_COMPLETED: "Batch completed",
};

export const when = (iso: string) => new Date(iso).toLocaleString();
