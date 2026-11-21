import { useEffect, useState, type FormEvent } from "react";

import { BRAND, Icon } from "./ui";

interface Result {
  found: boolean;
  status?: "VALID" | "CANCELLED";
  number?: string;
  holder?: string;
  course?: string;
  centre?: string;
  issuedAt?: string;
  cancelledAt?: string;
}

// PUBLIC page: no login. Opened from the QR code on a certificate (/verify/<code>) or by typing the
// verification code printed on it.
export default function Verify({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function check(value: string) {
    setResult(null);
    setMessage(null);
    const clean = value.trim().split("/").pop() ?? ""; // accepts a pasted link too
    if (!clean) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/verify/${encodeURIComponent(clean)}`);
      if (res.status === 429) return setMessage("Too many lookups. Please wait a minute and try again.");
      setResult((await res.json().catch(() => ({ found: false }))) as Result);
    } catch {
      setMessage("Could not reach the server. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (initialCode) void check(initialCode);
  }, [initialCode]);

  const ok = result?.found && result.status === "VALID";

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="auth-brand">
          <div className="brand-mark">
            <Icon name="shield" size={26} />
          </div>
          <h1>Verify a certificate</h1>
          <p>Check that a {BRAND} certificate is genuine. No account needed.</p>
        </div>

        <form
          className="card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void check(code);
          }}
        >
          <div className="field">
            <label htmlFor="code">Verification code</label>
            <input
              id="code"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="muted small" style={{ marginTop: 6 }}>
              It is printed under the QR code on the certificate. You can also paste the link.
            </p>
          </div>
          <button className="btn primary block" style={{ marginTop: 16 }} disabled={checking || !code.trim()}>
            {checking ? "Checking…" : "Check certificate"}
          </button>
          {message && <p style={{ marginTop: 12, color: "var(--danger)" }}>{message}</p>}
        </form>

        {result && result.found && (
          <section className={`card verdict ${ok ? "ok" : "bad"}`} style={{ marginTop: 16 }} aria-live="polite">
            <div className="icon">
              <Icon name={ok ? "check" : "x"} size={32} />
            </div>
            <h2>{ok ? "This certificate is genuine" : "This certificate is no longer valid"}</h2>
            <dl>
              <dt>Certificate number</dt>
              <dd>{result.number}</dd>
              <dt>Holder</dt>
              <dd>{result.holder}</dd>
              <dt>Course</dt>
              <dd>{result.course}</dd>
              <dt>Training centre</dt>
              <dd>{result.centre}</dd>
              <dt>Issued</dt>
              <dd>{result.issuedAt ? new Date(result.issuedAt).toLocaleDateString() : ""}</dd>
              {result.status === "CANCELLED" && (
                <>
                  <dt>Cancelled on</dt>
                  <dd>{result.cancelledAt ? new Date(result.cancelledAt).toLocaleString() : ""}</dd>
                </>
              )}
            </dl>
          </section>
        )}
        {result && !result.found && (
          <section className="card verdict bad" style={{ marginTop: 16 }} aria-live="polite">
            <div className="icon">
              <Icon name="x" size={32} />
            </div>
            <h2>No certificate found</h2>
            <p className="muted" style={{ marginTop: 8 }}>
              Check the code for typing mistakes. If it is correct, treat the certificate as not genuine.
            </p>
          </section>
        )}
        <p className="muted small" style={{ textAlign: "center", marginTop: 20 }}>
          <a href="/">Staff sign in</a>
        </p>
      </div>
    </div>
  );
}
