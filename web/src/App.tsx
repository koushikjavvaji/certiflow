import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, post, setToken, type ConfigView, type DemoUser, type Me } from "./api";
import Dashboard from "./Dashboard";
import { ROLE_LABEL } from "./format";
import Verify from "./Verify";

export default function App() {
  // The public verify page needs no login and is reached from the QR code on a certificate.
  const verifyMatch = window.location.pathname.match(/^\/verify\/?(.*)$/);
  if (verifyMatch) return <Verify initialCode={decodeURIComponent(verifyMatch[1] ?? "")} />;
  return <Staff />;
}

function Staff() {
  const [demoMode, setDemoMode] = useState(false);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      if (e instanceof ApiError && e.status === 401) setToken(null); // expired or rejected token
      setMe(null);
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    api<{ demoMode: boolean }>("/auth/config")
      .then(async (c) => {
        setDemoMode(c.demoMode);
        if (c.demoMode) setUsers((await api<{ users: DemoUser[] }>("/auth/demo-users")).users);
      })
      .catch((e) => setError(e.message));
    void loadSession();
  }, [loadSession]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await post<{ token: string }>("/auth/login", { email, password });
      setToken(token);
      setPassword("");
      await loadSession();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? "Enter a valid email address and your password."
          : err instanceof Error
            ? err.message
            : "sign-in failed",
      );
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setToken(null);
    setMe(null);
    setConfig(null);
    setError(null);
  }

  // Demo mode only: jump to any person without a password.
  async function switchTo(userId: string) {
    setError(null);
    if (!userId) return signOut();
    try {
      const { token } = await post<{ token: string }>("/auth/demo-login", { userId });
      setToken(token);
      await loadSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not switch");
    }
  }

  const demoSwitcher = demoMode && (
    <div className="who">
      <label htmlFor="who">Demo shortcut: act as (no password)</label>
      <select id="who" value={me?.id ?? ""} onChange={(e) => void switchTo(e.target.value)}>
        <option value="">Choose a person…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}: {ROLE_LABEL[u.role] ?? u.role}
            {u.district ? ` (${u.district.name})` : u.centre ? ` (${u.centre.name})` : ""}
          </option>
        ))}
      </select>
    </div>
  );

  if (!me) {
    return (
      <main className="narrow">
        <header>
          <h1>CertiFlow</h1>
          <p className="sub">Pragati Skills Mission · certificate issuance</p>
        </header>
        <form className="card" onSubmit={signIn}>
          <h2>Sign in</h2>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="wide"
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="wide"
            required
          />
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {demoSwitcher && <section className="card">{demoSwitcher}</section>}
        <p className="muted">
          Checking a certificate? No account needed: <a href="/verify">open the public verify page</a>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <header className="top">
        <div>
          <h1>CertiFlow</h1>
          <p className="sub">Pragati Skills Mission · certificate issuance</p>
        </div>
        <div className="who">
          <p className="you">
            Signed in as <strong>{me.name}</strong>, {ROLE_LABEL[me.role] ?? me.role}
          </p>
          <div className="row">
            <button onClick={signOut}>Sign out</button>
            <a href="/verify" target="_blank" rel="noreferrer">
              Public verify page
            </a>
          </div>
        </div>
      </header>
      {demoSwitcher}
      {error && <p className="error">{error}</p>}
      <Dashboard key={me.id} me={me} />
      {config && <Rules config={config} />}
    </main>
  );
}

// The live approval rules, read from the database. Edit a row there and this changes.
function Rules({ config }: { config: ConfigView }) {
  return (
    <details className="card">
      <summary>Live rules (read from the database)</summary>
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
            <th>Approvals</th>
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
                {s.scope === "DISTRICT" ? ", own district" : ""}
              </td>
              <td>{s.requiredApprovals}</td>
              <td>{s.slaMinutes ?? "none"}</td>
              <td>{s.condition ? JSON.stringify(s.condition) : "always"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="settings">
        {Object.entries(config.settings).map(([k, v]) => (
          <li key={k}>
            <code>{k}</code> = <code>{JSON.stringify(v)}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}
