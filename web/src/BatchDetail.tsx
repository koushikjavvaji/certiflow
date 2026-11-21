import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  downloadFile,
  post,
  put,
  type BatchDetail as Detail,
  type RowError,
  type WorkflowStep,
} from "./api";
import {
  ACTION_LABEL,
  ago,
  Chip,
  EmptyState,
  Icon,
  Progress,
  Skeleton,
  Stepper,
  StatusBadge,
  useToast,
  when,
} from "./ui";

// One batch: where it is on the approval path, what the signed-in person may do with it (the
// server decides that and sends `actions`), the people in it, its certificates and its history.
export default function BatchDetail({
  id,
  tick,
  steps,
  onChanged,
}: {
  id: string;
  tick: number;
  steps: WorkflowStep[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [rowErrors, setRowErrors] = useState<{ total: number; list: RowError[] } | null>(null);
  const [reason, setReason] = useState("");
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(`/batches/${id}`));
    } catch (e) {
      setD(null);
      toast(e instanceof Error ? e.message : "could not load the batch", "error");
    }
  }, [id]);
  useEffect(() => void load(), [load, tick]);

  // Runs one action, shows a toast, and refreshes. Returns true if it worked.
  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      toast(success);
      onChanged();
      await load();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "something went wrong", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return toast("Please choose a .csv file", "error");
    setRowErrors(null);
    setBusy(true);
    try {
      const res = await put<{ saved: number }>(`/batches/${id}/candidates`, { csv: await file.text() });
      toast(`Saved ${res.saved} candidates`);
      onChanged();
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const body = e.body as { totalErrors: number; errors: RowError[] };
        setRowErrors({ total: body.totalErrors, list: body.errors });
        toast(
          `Nothing was saved: ${body.totalErrors} problem${body.totalErrors === 1 ? "" : "s"} in the sheet`,
          "error",
        );
      } else {
        toast(e instanceof Error ? e.message : "upload failed", "error");
      }
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!d) {
    return (
      <section className="card stack">
        <Skeleton height={28} width="55%" />
        <Skeleton height={14} width="35%" />
        <Skeleton height={64} />
      </section>
    );
  }

  const can = (a: string) => d.actions.includes(a);
  const delivered = d.certificates.filter((c) => c.deliveryStatus === "SENT").length;
  const failed = d.certificates.filter((c) => c.deliveryStatus === "FAILED").length;
  const hasCodes = d.certificates.some((c) => c.verifyCode); // only the state office and the owning centre see codes
  const { batch } = d;

  return (
    <>
      {/* ---------- Where is it? ---------- */}
      <section className="card">
        <div className="card-head">
          <div>
            <h2>{batch.courseName}</h2>
            <p className="muted small">
              {batch.centreName} · {batch.candidateCount} candidates
              {batch.version > 1 ? ` · version ${batch.version}` : ""}
            </p>
          </div>
          <div className="chips">
            {batch.overdue && (
              <Chip tone="danger" icon="clock">
                Overdue
              </Chip>
            )}
            <StatusBadge status={batch.status} />
          </div>
        </div>

        <Stepper
          steps={steps}
          count={batch.candidateCount}
          currentKey={batch.stepKey}
          status={batch.status}
          approvals={d.approvals.length}
          needed={batch.approvalsNeed}
        />

        {batch.status === "IN_REVIEW" && (
          <p className="muted small" style={{ marginTop: 10 }}>
            Waiting at <b>{batch.stepName}</b>: {d.approvals.length} of {batch.approvalsNeed} approvals
            {d.approvals.length > 0 && ` (${d.approvals.map((a) => a.officer).join(", ")})`}
          </p>
        )}
        {batch.lastReason && (batch.status === "CHANGES_REQUESTED" || batch.status === "REJECTED") && (
          <div className={`notice ${batch.status === "REJECTED" ? "danger" : ""}`} style={{ marginTop: 14 }}>
            <Icon name="alert" />
            <div>
              <b>{batch.status === "REJECTED" ? "Rejected" : "Sent back for changes"}</b>
              <div>{batch.lastReason}</div>
            </div>
          </div>
        )}
        {(batch.status === "ISSUING" || batch.status === "COMPLETED") && (
          <div className="stack" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <b>{delivered}</b> of {batch.candidateCount} certificates delivered on WhatsApp
              </span>
              {failed > 0 && (
                <Chip tone="danger" icon="alert">
                  {failed} could not be delivered
                </Chip>
              )}
            </div>
            <Progress value={delivered} max={batch.candidateCount} tone="success" />
          </div>
        )}
      </section>

      {/* ---------- Centre: upload and submit ---------- */}
      {can("UPLOAD") && (
        <section className="card">
          <div className="card-head">
            <h3>
              <Icon name="upload" /> Candidates
            </h3>
          </div>
          <p className="muted small" style={{ marginBottom: 12 }}>
            Upload a CSV with the columns <code>name</code>, <code>phone</code>, <code>courseCode</code>,{" "}
            <code>marks</code> (optional). Every row is checked, and if any row is wrong, nothing is saved.
          </p>
          <div
            className={`dropzone ${drag ? "drag" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void upload(e.dataTransfer.files[0]);
            }}
          >
            <Icon name="upload" size={28} />
            <span>
              <b>Drop your CSV here</b> or click to browse
            </span>
            <span className="muted small">
              {batch.candidateCount > 0
                ? `Currently ${batch.candidateCount} candidates. A new upload replaces them.`
                : "No candidates yet"}
            </span>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <p className="muted small" style={{ marginTop: 10 }}>
            Try a sample:{" "}
            <a href="/samples/small-5.csv" download>
              small-5
            </a>{" "}
            ·{" "}
            <a href="/samples/big-60.csv" download>
              big-60
            </a>{" "}
            ·{" "}
            <a href="/samples/bad-rows.csv" download>
              bad-rows
            </a>
          </p>

          {rowErrors && (
            <div className="errors-panel">
              <b>
                {rowErrors.total} problem{rowErrors.total === 1 ? "" : "s"} found. Nothing was saved.
              </b>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Field</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowErrors.list.map((r, i) => (
                      <tr key={i}>
                        <td>{r.row || "file"}</td>
                        <td>{r.field ?? ""}</td>
                        <td>{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {can("SUBMIT") && (
            <div style={{ marginTop: 16 }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void run(() => post(`/batches/${id}/submit`), "Submitted for approval")}
              >
                Submit for approval
              </button>
            </div>
          )}
        </section>
      )}

      {/* ---------- Reviewer: decide ---------- */}
      {(can("APPROVE") || can("SEND_BACK")) && (
        <section className="card">
          <div className="card-head">
            <h3>
              <Icon name="shield" /> Your decision
            </h3>
          </div>
          <textarea
            className="textarea"
            placeholder="Reason (required to send back or reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason"
          />
          <div className="row" style={{ marginTop: 12 }}>
            {can("APPROVE") && (
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void run(() => post(`/batches/${id}/decision`, { decision: "APPROVE" }), "Approved")}
              >
                <Icon name="check" size={16} /> Approve
              </button>
            )}
            <button
              className="btn"
              disabled={busy || reason.trim().length < 3}
              onClick={async () =>
                (await run(
                  () => post(`/batches/${id}/decision`, { decision: "SEND_BACK", reason }),
                  "Sent back to the centre",
                )) && setReason("")
              }
            >
              <Icon name="undo" size={16} /> Send back
            </button>
            <button
              className="btn danger"
              disabled={busy || reason.trim().length < 3}
              onClick={async () =>
                (await run(() => post(`/batches/${id}/decision`, { decision: "REJECT", reason }), "Batch rejected")) &&
                setReason("")
              }
            >
              <Icon name="x" size={16} /> Reject
            </button>
          </div>
        </section>
      )}
      {can("WITHDRAW") && (
        <section className="card row" style={{ justifyContent: "space-between" }}>
          <span>You approved this step. Made a mistake?</span>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => post(`/batches/${id}/withdraw`), "Approval withdrawn")}
          >
            <Icon name="undo" size={16} /> Withdraw my approval
          </button>
        </section>
      )}

      {/* ---------- Certificates ---------- */}
      {d.certificates.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>
              <Icon name="file" /> Certificates ({d.certificates.length})
            </h3>
          </div>
          <div className="table-wrap cert-scroll">
            <table>
              <thead>
                <tr>
                  <th>Certificate</th>
                  <th>Delivery</th>
                  {hasCodes && <th>Verification code</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.certificates.map((c) => (
                  <Fragment key={c.id}>
                    <tr className={c.status === "CANCELLED" ? "struck" : ""}>
                      <td>
                        <div className="holder">{c.holder}</div>
                        <div className="muted small mono">{c.number}</div>
                      </td>
                      <td className="nowrap">
                        {c.status === "CANCELLED" ? (
                          <Chip tone="danger">Cancelled</Chip>
                        ) : c.deliveryStatus === "SENT" ? (
                          <Chip tone="success" icon="check">
                            Delivered{c.attempts > 1 ? ` · ${c.attempts} tries` : ""}
                          </Chip>
                        ) : c.deliveryStatus === "FAILED" ? (
                          <Chip tone="danger">Failed</Chip>
                        ) : (
                          <Chip>Pending</Chip>
                        )}
                      </td>
                      {hasCodes && (
                        <td className="mono nowrap">
                          {c.verifyCode && (
                            <a href={`/verify/${c.verifyCode.replaceAll("-", "")}`} target="_blank" rel="noreferrer">
                              {c.verifyCode}
                            </a>
                          )}
                        </td>
                      )}
                      <td className="cell-actions">
                        <div className="actions">
                          {c.status === "VALID" && (
                            <button
                              className="btn sm"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => downloadFile(`/certificates/${c.id}/pdf`, `${c.number}.pdf`),
                                  "Download started",
                                )
                              }
                            >
                              <Icon name="download" size={14} /> PDF
                            </button>
                          )}
                          {can("RETRY_DELIVERY") && c.deliveryStatus === "FAILED" && c.status === "VALID" && (
                            <button
                              className="btn sm"
                              disabled={busy}
                              onClick={() => void run(() => post(`/certificates/${c.id}/retry`), "Retrying delivery")}
                            >
                              Retry
                            </button>
                          )}
                          {can("CANCEL_CERTIFICATE") && c.status === "VALID" && (
                            <button
                              className="btn sm danger"
                              disabled={busy}
                              onClick={() => (setCancelFor(cancelFor === c.id ? null : c.id), setCancelReason(""))}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {cancelFor === c.id && (
                      <tr className="cancel-row">
                        <td colSpan={hasCodes ? 4 : 3}>
                          <div className="row">
                            <input
                              className="input grow"
                              autoFocus
                              placeholder={`Why is ${c.number} being cancelled?`}
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                              aria-label="Reason for cancelling"
                            />
                            <button
                              className="btn danger"
                              disabled={busy || cancelReason.trim().length < 3}
                              onClick={async () =>
                                (await run(
                                  () => post(`/certificates/${c.id}/cancel`, { reason: cancelReason }),
                                  "Certificate cancelled",
                                )) && setCancelFor(null)
                              }
                            >
                              Confirm cancel
                            </button>
                            <button className="btn ghost" onClick={() => setCancelFor(null)}>
                              Never mind
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---------- People ---------- */}
      {d.candidates.length > 0 && (
        <details className="card" open={d.candidates.length <= 8}>
          <summary>Candidates ({d.candidates.length})</summary>
          <div className="table-wrap scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Course</th>
                  <th>Marks</th>
                </tr>
              </thead>
              <tbody>
                {d.candidates.map((c, i) => (
                  <tr key={c.id}>
                    <td className="muted">{i + 1}</td>
                    <td>{c.name}</td>
                    <td>{c.phone}</td>
                    <td>{c.courseCode}</td>
                    <td>{c.marks ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* ---------- History ---------- */}
      <section className="card">
        <div className="card-head">
          <h3>
            <Icon name="clock" /> History
          </h3>
          <span className="muted small">Who, when and why. This record can't be edited.</span>
        </div>
        <ol className="timeline">
          {[...d.audit].reverse().map((a) => (
            <li key={a.id}>
              <b>{a.actor}</b> · {ACTION_LABEL[a.action] ?? a.action}
              {a.reason ? <em> “{a.reason}”</em> : null}
              <span className="when" title={when(a.at)}>
                {ago(a.at)}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
