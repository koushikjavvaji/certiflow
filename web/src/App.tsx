import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, getToken, post, setToken, type ConfigView, type DemoUser, type Me } from "./api";
import Dashboard from "./Dashboard";
import { BRAND, BRAND_TELUGU, Icon, ROLE_LABEL, TAGLINE, ToastProvider } from "./ui";
import Verify from "./Verify";

const ROLE_BLURB: Record<string, string> = {
  CENTRE: "Create batches, upload your candidates and follow their approval.",
  DISTRICT_OFFICER: "Review the batches from your district.",
  QUALITY: "Give big batches a closer look.",
  STATE: "Give final approval, watch for stuck batches and handle certificates.",
};

export default function App() {
  // The public verify page needs no login and is reached from the QR code on a certificate.
  const verifyMatch = window.location.pathname.match(/^\/verify\/?(.*)$/);
  return (
    <ToastProvider>
      {verifyMatch ? <Verify initialCode={decodeURIComponent(verifyMatch[1] ?? "")} /> : <Staff />}
    </ToastProvider>
  );
}

function Brand() {
  return (
    <a className="brand" href="/">
      <span className="brand-mark">
        <Icon name="shield" size={18} />
      </span>
      {BRAND}
      <span className="brand-te">{BRAND_TELUGU}</span>
    </a>
  );
}

function Staff() {
  const [demoMode, setDemoMode] = useState(false);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [booting, setBooting] = useState(true);
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
      .catch((e: Error) => setError(e.message));
    void loadSession().finally(() => setBooting(false));
  }, [loadSession]);

  async function signIn(e: FormEvent) {
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
    <div className="demo-bar">
      <b>Demo</b>
      <span className="muted">Act as</span>
      <select
        className="select"
        value={me?.id ?? ""}
        onChange={(e) => void switchTo(e.target.value)}
        aria-label="Act as"
      >
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

  if (booting) return <div className="auth-wrap" aria-busy="true" />;

  // ---------------------------------- Sign-in ----------------------------------
  if (!me) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <div className="brand-mark">
              <Icon name="shield" size={26} />
            </div>
            <h1>
              {BRAND} <span className="brand-te">{BRAND_TELUGU}</span>
            </h1>
            <p>{TAGLINE}</p>
          </div>
          <form className="card" onSubmit={signIn}>
            <h2 style={{ marginBottom: 16 }}>Sign in</h2>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p role="alert" style={{ color: "var(--danger)", marginTop: 12 }}>
                {error}
              </p>
            )}
            <button className="btn primary block" style={{ marginTop: 18 }} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {demoSwitcher && <div style={{ marginTop: 16 }}>{demoSwitcher}</div>}
          <p className="muted small" style={{ textAlign: "center", marginTop: 20 }}>
            Checking a certificate? <a href="/verify">Verify it here</a>, no account needed.
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------- Signed in ----------------------------------
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <div className="spacer" />
          <a className="btn ghost sm" href="/verify" target="_blank" rel="noreferrer">
            Verify a certificate
          </a>
          <div className="user-chip">
            <div className="avatar">{me.name.charAt(0)}</div>
            <div className="user-meta">
              <b>{me.name}</b>
              <span>{ROLE_LABEL[me.role] ?? me.role}</span>
            </div>
          </div>
          <button className="btn ghost sm" onClick={signOut} aria-label="Sign out">
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </header>
      <main className="container">
        {demoSwitcher}
        <div className="page-title">
          <h1>Batches</h1>
          <p>{ROLE_BLURB[me.role]}</p>
        </div>
        <Dashboard key={me.id} me={me} steps={config?.workflow.steps ?? []} />
        {config && <Rules config={config} />}
      </main>
    </>
  );
}

// The live approval rules, read from the database. Edit a row there and this changes.
function Rules({ config }: { config: ConfigView }) {
  return (
    <details className="card" style={{ marginTop: 28 }}>
      <summary>How approvals work (live rules)</summary>
      <p className="muted small">
        Workflow version {config.workflow.version}. These rows live in the database, so changing them changes behaviour
        within seconds, with no redeploy.
      </p>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Who acts</th>
              <th>Approvals</th>
              <th>Time limit</th>
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
                <td>{s.slaMinutes ? `${Math.round(s.slaMinutes / 60)} h` : "none"}</td>
                <td>{s.condition?.minCandidates ? `${s.condition.minCandidates}+ candidates` : "always"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="rules-list">
        {Object.entries(config.settings).map(([k, v]) => (
          <li key={k}>
            <code>{k}</code> = <code>{JSON.stringify(v)}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}
