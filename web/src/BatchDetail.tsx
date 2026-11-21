import { useCallback, useEffect, useState } from "react";
import { api, ApiError, downloadFile, post, put, type BatchDetail as Detail, type RowError } from "./api";
import { ACTION_LABEL, STATUS_LABEL, when } from "./format";

// One batch: what it is, what the signed-in person may do with it (the server decides
// that and sends `actions`), the people in it, certificates, and the full history.
export default function BatchDetail({ id, tick, onChanged }: { id: string; tick: number; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<{ total: number; list: RowError[] } | null>(null);
  const [reason, setReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(`/batches/${id}`));
    } catch (e) {
      setD(null);
      setError(e instanceof Error ? e.message : "could not load");
    }
  }, [id]);
  useEffect(() => void load(), [load, tick]);
  useEffect(() => {
    setReason("");
    setRowErrors(null);
    setError(null);
  }, [id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setRowErrors(null);
    await run(async () => {
      try {
        await put(`/batches/${id}/candidates`, { csv: await file.text() });
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          const body = e.body as { totalErrors: number; errors: RowError[] };
          setRowErrors({ total: body.totalErrors, list: body.errors });
          throw new Error(`Nothing was saved: ${body.totalErrors} problem(s) found. Fix the sheet and upload again.`);
        }
        throw e;
      }
    });
  }

  if (!d)
    return (
      <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>
    );
  const can = (a: string) => d.actions.includes(a);
  const delivered = d.certificates.filter((c) => c.deliveryStatus === "SENT").length;

  return (
    <>
      <section className="card">
        <div className="title-row">
          <h2>{d.batch.courseName}</h2>
          <span className={`badge ${d.batch.status.toLowerCase()}`}>
            {STATUS_LABEL[d.batch.status] ?? d.batch.status}
          </span>
        </div>
        <p className="muted">
          {d.batch.centreName} · {d.batch.candidateCount} candidate(s)
          {d.batch.version > 1 ? ` · version ${d.batch.version}` : ""}
        </p>
        {d.batch.status === "IN_REVIEW" && (
          <p>
            Waiting at <strong>{d.batch.stepName}</strong>: {d.approvals.length} of {d.batch.approvalsNeed} approval(s)
            {d.approvals.length > 0 && ` (${d.approvals.map((a) => a.officer).join(", ")})`}
            {d.batch.overdue && <span className="badge overdue">Overdue</span>}
          </p>
        )}
        {d.batch.lastReason && (d.batch.status === "CHANGES_REQUESTED" || d.batch.status === "REJECTED") && (
          <p className="notice">
            <strong>{d.batch.status === "REJECTED" ? "Rejected" : "Sent back"}:</strong> {d.batch.lastReason}
          </p>
        )}
        {(d.batch.status === "ISSUING" || d.batch.status === "COMPLETED") && (
          <p>
            {delivered} of {d.batch.candidateCount} certificates delivered on WhatsApp
            {d.certificates.some((c) => c.deliveryStatus === "FAILED") && " (some could not be delivered)"}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {can("UPLOAD") && (
        <section className="card">
          <h3>Candidates</h3>
          <p className="muted">
            Upload your spreadsheet as CSV with columns <code>name, phone, courseCode, marks</code>. Every row is
            checked; if any row is bad, nothing is saved. Samples:{" "}
            <a href="/samples/small-5.csv" download>
              small-5
            </a>
            ,{" "}
            <a href="/samples/big-60.csv" download>
              big-60
            </a>
            ,{" "}
            <a href="/samples/bad-rows.csv" download>
              bad-rows
            </a>
            .
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          {rowErrors && (
            <div className="errors">
              <strong>{rowErrors.total} problem(s) found. Nothing was saved.</strong>
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
          )}
          {can("SUBMIT") && (
            <button className="primary" disabled={busy} onClick={() => void run(() => post(`/batches/${id}/submit`))}>
              Submit for approval
            </button>
          )}
        </section>
      )}

      {(can("APPROVE") || can("SEND_BACK")) && (
        <section className="card">
          <h3>Your decision</h3>
          <textarea
            placeholder="Reason (required to send back or reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="row">
            {can("APPROVE") && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(() => post(`/batches/${id}/decision`, { decision: "APPROVE" }))}
              >
                Approve
              </button>
            )}
            <button
              disabled={busy || reason.trim().length < 3}
              onClick={() => void run(() => post(`/batches/${id}/decision`, { decision: "SEND_BACK", reason }))}
            >
              Send back
            </button>
            <button
              className="danger"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void run(() => post(`/batches/${id}/decision`, { decision: "REJECT", reason }))}
            >
              Reject
            </button>
          </div>
        </section>
      )}
      {can("WITHDRAW") && (
        <section className="card">
          <p>You approved this step. Made a mistake?</p>
          <button disabled={busy} onClick={() => void run(() => post(`/batches/${id}/withdraw`))}>
            Withdraw my approval
          </button>
        </section>
      )}

      {d.certificates.length > 0 && (
        <section className="card">
          <h3>Certificates</h3>
          {can("CANCEL_CERTIFICATE") && (
            <input
              className="wide"
              placeholder="Reason for cancelling (needed to cancel a certificate)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          )}
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Holder</th>
                <th>Delivery</th>
                <th>Status</th>
                <th>Verification</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.certificates.map((c) => (
                <tr key={c.id} className={c.status === "CANCELLED" ? "struck" : ""}>
                  <td>{c.number}</td>
                  <td>{c.holder}</td>
                  <td>
                    {c.deliveryStatus === "SENT" ? "Sent" : c.deliveryStatus === "FAILED" ? "Failed" : "Pending"}
                    {c.attempts > 1 ? ` (${c.attempts} tries)` : ""}
                  </td>
                  <td>{c.status === "CANCELLED" ? "Cancelled" : "Valid"}</td>
                  <td>
                    {c.verifyCode ? (
                      <a href={`/verify/${c.verifyCode.replaceAll("-", "")}`} target="_blank" rel="noreferrer">
                        {c.verifyCode}
                      </a>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="cell-actions">
                    {c.status === "VALID" && (
                      <button
                        className="small"
                        disabled={busy}
                        onClick={() => void run(() => downloadFile(`/certificates/${c.id}/pdf`, `${c.number}.pdf`))}
                      >
                        Download PDF
                      </button>
                    )}
                    {can("CANCEL_CERTIFICATE") && c.status === "VALID" && (
                      <button
                        className="danger small"
                        disabled={busy || cancelReason.trim().length < 3}
                        onClick={() => void run(() => post(`/certificates/${c.id}/cancel`, { reason: cancelReason }))}
                      >
                        Cancel
                      </button>
                    )}
                    {can("RETRY_DELIVERY") && c.deliveryStatus === "FAILED" && c.status === "VALID" && (
                      <button
                        className="small"
                        disabled={busy}
                        onClick={() => void run(() => post(`/certificates/${c.id}/retry`))}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h3>Candidates ({d.candidates.length})</h3>
        <div className="scroll">
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
                  <td>{i + 1}</td>
                  <td>{c.name}</td>
                  <td>{c.phone}</td>
                  <td>{c.courseCode}</td>
                  <td>{c.marks ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>History</h3>
        <p className="muted">Every decision, with who, when and why. This record cannot be edited.</p>
        <ul className="history">
          {[...d.audit].reverse().map((a) => (
            <li key={a.id}>
              <span className="when">{when(a.at)}</span> <strong>{a.actor}</strong>:{" "}
              {ACTION_LABEL[a.action] ?? a.action}
              {a.reason ? <em> “{a.reason}”</em> : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
