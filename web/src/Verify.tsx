import { useEffect, useState } from "react";

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

// PUBLIC page: no login. Opened from the QR code on a certificate (/verify/<code>) or by
// typing the verification code printed on it.
export default function Verify({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function check(value: string) {
    setResult(null);
    setMessage(null);
    const clean = value.trim().split("/").pop() ?? ""; // accepts a pasted link too
    if (!clean) return;
    const res = await fetch(`/api/verify/${encodeURIComponent(clean)}`);
    if (res.status === 429) return setMessage("Too many lookups. Please wait a minute and try again.");
    const body = (await res.json().catch(() => ({ found: false }))) as Result;
    setResult(body);
  }

  useEffect(() => {
    if (initialCode) void check(initialCode);
  }, [initialCode]);

  return (
    <main>
      <header>
        <h1>Verify a certificate</h1>
        <p className="sub">Pragati Skills Mission. No login needed.</p>
      </header>
      <section className="card">
        <label htmlFor="code">Verification code (printed under the QR code on the certificate)</label>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void check(code);
          }}
        >
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" />
          <button type="submit">Check</button>
        </form>
        {message && <p className="error">{message}</p>}
      </section>

      {result && result.found && (
        <section className={`card verdict ${result.status === "VALID" ? "ok" : "bad"}`}>
          <h2>{result.status === "VALID" ? "✔ Genuine certificate" : "✘ This certificate is no longer valid"}</h2>
          <dl>
            <dt>Certificate number</dt><dd>{result.number}</dd>
            <dt>Holder</dt><dd>{result.holder}</dd>
            <dt>Course</dt><dd>{result.course}</dd>
            <dt>Training centre</dt><dd>{result.centre}</dd>
            <dt>Issued</dt><dd>{result.issuedAt ? new Date(result.issuedAt).toLocaleDateString() : ""}</dd>
            {result.status === "CANCELLED" && <><dt>Cancelled on</dt><dd>{result.cancelledAt ? new Date(result.cancelledAt).toLocaleString() : ""}</dd></>}
          </dl>
        </section>
      )}
      {result && !result.found && (
        <section className="card verdict bad">
          <h2>✘ No certificate found for this code</h2>
          <p className="muted">Check the code for typing mistakes. If it is correct, treat the certificate as not genuine.</p>
        </section>
      )}
    </main>
  );
}
