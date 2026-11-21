import { useCallback, useEffect, useState } from "react";
import { api, post, type BatchSummary, type Me, type View } from "./api";
import BatchDetail from "./BatchDetail";
import { STATUS_LABEL } from "./format";
import { useLive } from "./live";

const TABS: Record<string, { view: View; label: string }[]> = {
  CENTRE: [{ view: "all", label: "My batches" }],
  DISTRICT_OFFICER: [
    { view: "waiting", label: "Waiting for me" },
    { view: "all", label: "All in my district" },
  ],
  QUALITY: [
    { view: "waiting", label: "Waiting for me" },
    { view: "all", label: "All batches" },
  ],
  STATE: [
    { view: "waiting", label: "Waiting for me" },
    { view: "stuck", label: "Stuck" },
    { view: "all", label: "All batches" },
  ],
};

export default function Dashboard({ me }: { me: Me }) {
  const tabs = TABS[me.role] ?? [];
  const [view, setView] = useState<View>(tabs[0]?.view ?? "all");
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [stuck, setStuck] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [course, setCourse] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  useLive(reload, true); // changes made by anyone appear here without refreshing

  useEffect(() => {
    api<{ batches: BatchSummary[] }>(`/batches?view=${view}`)
      .then((r) => setBatches(r.batches))
      .catch((e) => setError(e.message));
    if (me.role === "STATE")
      api<{ batches: BatchSummary[] }>("/batches?view=stuck")
        .then((r) => setStuck(r.batches.length))
        .catch(() => undefined);
  }, [view, tick, me.role]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { id } = await post<{ id: string }>("/batches", { courseName: course });
      setCourse("");
      setSelected(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create");
    }
  }

  return (
    <div className="split">
      <div>
        {me.role === "STATE" && stuck > 0 && view !== "stuck" && (
          <button className="alert" onClick={() => setView("stuck")}>
            ⚠ {stuck} batch(es) are stuck past their time limit. View
          </button>
        )}
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.view} className={view === t.view ? "tab on" : "tab"} onClick={() => setView(t.view)}>
              {t.label}
            </button>
          ))}
        </div>
        {me.role === "CENTRE" && (
          <form className="row new" onSubmit={create}>
            <input
              placeholder="New batch: course name, e.g. Welding Basics"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
            />
            <button className="primary" disabled={course.trim().length < 2}>
              Create
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
        <ul className="batches">
          {batches.length === 0 && <li className="muted empty">Nothing here.</li>}
          {batches.map((b) => (
            <li key={b.id}>
              <button className={`batch ${selected === b.id ? "on" : ""}`} onClick={() => setSelected(b.id)}>
                <span className="b-title">{b.courseName}</span>
                <span className={`badge ${b.status.toLowerCase()}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
                <span className="muted b-sub">
                  {b.centreName} · {b.candidateCount} candidates
                  {b.stepName ? ` · ${b.stepName} (${b.approvalsHave}/${b.approvalsNeed})` : ""}
                </span>
                {b.overdue && <span className="badge overdue">Overdue</span>}
                {b.waitingForMe && <span className="badge mine">Your turn</span>}
                {b.lastReason && <span className="b-reason">“{b.lastReason}”</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        {selected ? (
          <BatchDetail id={selected} tick={tick} onChanged={reload} />
        ) : (
          <section className="card muted">Select a batch to see it.</section>
        )}
      </div>
    </div>
  );
}
