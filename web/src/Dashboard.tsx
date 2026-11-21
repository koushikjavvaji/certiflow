import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, post, type BatchSummary, type Me, type View, type WorkflowStep } from "./api";
import BatchDetail from "./BatchDetail";
import { useLive } from "./live";
import { ago, Chip, EmptyState, Icon, Progress, Skeleton, StatusBadge, useToast } from "./ui";

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

const EMPTY: Record<View, { title: string; text: string }> = {
  waiting: { title: "You're all caught up", text: "Nothing is waiting for your decision right now." },
  stuck: { title: "Nothing is stuck", text: "No batch has waited past its time limit." },
  all: { title: "No batches yet", text: "They will appear here as soon as they exist." },
};

export default function Dashboard({ me, steps }: { me: Me; steps: WorkflowStep[] }) {
  const tabs = TABS[me.role] ?? [];
  const toast = useToast();
  const [view, setView] = useState<View>(tabs[0]?.view ?? "all");
  const [lists, setLists] = useState<Partial<Record<View, BatchSummary[]>>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [course, setCourse] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  useLive(reload, true); // changes made by anyone appear here without refreshing

  // One request per tab, so every tab can show its own count.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      tabs.map(
        async (t) => [t.view, (await api<{ batches: BatchSummary[] }>(`/batches?view=${t.view}`)).batches] as const,
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setLists(Object.fromEntries(entries));
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        toast(e.message, "error");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick, me.role]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const { id } = await post<{ id: string }>("/batches", { courseName: course });
      setCourse("");
      setSelected(id);
      toast("Batch created. Now upload your candidates.");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "could not create the batch", "error");
    } finally {
      setCreating(false);
    }
  }

  const batches = lists[view] ?? [];
  const stuckCount = lists.stuck?.length ?? 0;

  return (
    <div className="split">
      <div>
        {me.role === "STATE" && stuckCount > 0 && view !== "stuck" && (
          <button className="alert-banner" onClick={() => setView("stuck")}>
            <Icon name="alert" /> {stuckCount} {stuckCount === 1 ? "batch is" : "batches are"} stuck past the time
            limit. Review now
          </button>
        )}

        {tabs.length > 1 && (
          <div className="tabs" role="tablist">
            {tabs.map((t) => {
              const n = lists[t.view]?.length ?? 0;
              return (
                <button
                  key={t.view}
                  role="tab"
                  aria-selected={view === t.view}
                  className={`tab ${view === t.view ? "on" : ""}`}
                  onClick={() => setView(t.view)}
                >
                  {t.label}
                  <span className={`count ${n === 0 ? "zero" : ""}`}>{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {me.role === "CENTRE" && (
          <form className="card new-batch" onSubmit={create}>
            <div className="card-head">
              <h3>
                <Icon name="plus" /> New batch
              </h3>
            </div>
            <div className="row">
              <input
                className="input grow"
                placeholder="Course name, e.g. Welding Basics"
                value={course}
                onChange={(e) => setCourse(e.target.value)}
                aria-label="Course name"
              />
              <button className="btn primary" disabled={creating || course.trim().length < 2}>
                Create
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <ul className="list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="card stack">
                <Skeleton height={20} width="60%" />
                <Skeleton height={14} width="85%" />
                <Skeleton height={8} />
              </li>
            ))}
          </ul>
        ) : batches.length === 0 ? (
          <div className="card">
            <EmptyState title={EMPTY[view].title}>{EMPTY[view].text}</EmptyState>
          </div>
        ) : (
          <ul className="list">
            {batches.map((b) => (
              <li key={b.id}>
                <button className={`batch-card ${selected === b.id ? "on" : ""}`} onClick={() => setSelected(b.id)}>
                  <div className="top">
                    <span className="title">{b.courseName}</span>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="meta">
                    {b.centreName} · {b.candidateCount} candidates · {ago(b.updatedAt)}
                  </div>
                  {b.status === "IN_REVIEW" && b.stepName && b.approvalsNeed ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="meta">
                        {b.stepName} · {b.approvalsHave} of {b.approvalsNeed} approvals
                      </div>
                      <Progress value={b.approvalsHave} max={b.approvalsNeed} small />
                    </div>
                  ) : null}
                  {(b.waitingForMe || b.overdue) && (
                    <div className="chips">
                      {b.waitingForMe && <Chip tone="accent">Your turn</Chip>}
                      {b.overdue && (
                        <Chip tone="danger" icon="clock">
                          Overdue
                        </Chip>
                      )}
                    </div>
                  )}
                  {b.lastReason && <div className="quote">“{b.lastReason}”</div>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        {selected ? (
          <BatchDetail key={selected} id={selected} tick={tick} steps={steps} onChanged={reload} />
        ) : (
          <div className="card">
            <EmptyState icon="file" title="Select a batch">
              Pick one from the list to see its progress, people and history.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
