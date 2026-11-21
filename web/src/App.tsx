import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type ConfigView, type DemoUser, type Me } from "./api";

const ROLE_LABEL: Record<string, string> = {
  CENTRE: "Training centre",
  DISTRICT_OFFICER: "District officer",
  QUALITY: "Quality team",
  STATE: "State office",
};

export default function App() {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setConfig(null);
      return;
    }
    try {
      const [{ user }, cfg] = await Promise.all([api<{ user: Me }>("/me"), api<ConfigView>("/config")]);
      setMe(user);
      setConfig(cfg);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setToken(null); // stale or rejected token
      setMe(null);
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    api<{ users: DemoUser[] }>("/auth/demo-users")
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
    void loadSession();
  }, [loadSession]);

  async function switchTo(userId: string) {
    setError(null);
    if (!userId) {
      setToken(null);
      return loadSession();
    }
    try {
      const { token } = await api<{ token: string }>("/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setToken(token);
      await loadSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : "login failed");
    }
  }

  return (
    <main>
      <header>
        <h1>CertiFlow</h1>
        <p className="sub">Pragati Skills Mission: certificate issuance platform</p>
      </header>

      <section className="card">
        <label htmlFor="who">Demo mode: act as</label>
        <select id="who" value={me?.id ?? ""} onChange={(e) => void switchTo(e.target.value)}>
          <option value="">Choose a person…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}: {ROLE_LABEL[u.role] ?? u.role}
              {u.district ? ` (${u.district.name})` : u.centre ? ` (${u.centre.name})` : ""}
            </option>
          ))}
        </select>
        {error && <p className="error">{error}</p>}
        {me ? (
          <p className="you">
            You are <strong>{me.name}</strong>, role <strong>{ROLE_LABEL[me.role] ?? me.role}</strong>
          </p>
        ) : (
          <p className="muted">Not signed in. Pick a person above.</p>
        )}
      </section>

      {config && (
        <section className="card">
          <h2>Live rules (read from the database)</h2>
          <p className="muted">
            Workflow version {config.workflow.version}. Changing these rows in the database changes behaviour within
            seconds, with no redeploy.
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Step</th>
                <th>Who acts</th>
                <th>Approvals needed</th>
                <th>SLA (min)</th>
                <th>Applies when</th>
              </tr>
            </thead>
            <tbody>
              {config.workflow.steps.map((s) => (
                <tr key={s.key}>
                  <td>{s.position}</td>
                  <td>{s.name}</td>
                  <td>
                    {ROLE_LABEL[s.role] ?? s.role}
                    {s.scope === "DISTRICT" ? ", own district only" : ""}
                  </td>
                  <td>{s.requiredApprovals}</td>
                  <td>{s.slaMinutes ?? "none"}</td>
                  <td>{s.condition ? JSON.stringify(s.condition) : "always"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Settings</h3>
          <ul className="settings">
            {Object.entries(config.settings).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code> = <code>{JSON.stringify(v)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
