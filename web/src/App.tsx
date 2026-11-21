import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type ConfigView, type DemoUser, type Me } from "./api";
import Dashboard from "./Dashboard";
import { ROLE_LABEL } from "./format";
import Rules from "./Rules";
import Verify from "./Verify";

export default function App() {
  // The public verify page needs no login and is reached from the QR code on a certificate.
  const verifyMatch = window.location.pathname.match(/^\/verify\/?(.*)$/);
  if (verifyMatch) return <Verify initialCode={decodeURIComponent(verifyMatch[1] ?? "")} />;
  return <Staff />;
}

function Staff() {
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
    api<{ users: DemoUser[] }>("/auth/demo-users").then((r) => setUsers(r.users)).catch((e) => setError(e.message));
    void loadSession();
  }, [loadSession]);

  async function switchTo(userId: string) {
    setError(null);
    if (!userId) {
      setToken(null);
      return loadSession();
    }
    try {
      const { token } = await api<{ token: string }>("/auth/demo-login", { method: "POST", body: JSON.stringify({ userId }) });
      setToken(token);
      await loadSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : "login failed");
    }
  }

  return (
    <main>
      <header className="top">
        <div>
          <h1>CertiFlow</h1>
          <p className="sub">Pragati Skills Mission · certificate issuance</p>
        </div>
        <div className="who">
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
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {me ? (
        <>
          <p className="you">You are <strong>{me.name}</strong>, {ROLE_LABEL[me.role] ?? me.role}. <a href="/verify" target="_blank" rel="noreferrer">Public verify page</a></p>
          <Dashboard key={me.id} me={me} />
          {config && <Rules config={config} />}
        </>
      ) : (
        <section className="card">
          <p className="muted">Pick a person above to start. Anyone (an employer, say) can also use the <a href="/verify">public verify page</a> without logging in.</p>
        </section>
      )}
    </main>
  );
}
