import { ROLE_LABEL } from "./format";
import type { ConfigView } from "./api";

// The live approval rules, read from the database. Edit a row there and this changes.
export default function Rules({ config }: { config: ConfigView }) {
  return (
    <details className="card">
      <summary>Live rules (read from the database)</summary>
      <p className="muted">Workflow version {config.workflow.version}. Changing these rows in the database changes behaviour within seconds, with no redeploy.</p>
      <table>
        <thead><tr><th>#</th><th>Step</th><th>Who acts</th><th>Approvals</th><th>SLA (min)</th><th>Applies when</th></tr></thead>
        <tbody>
          {config.workflow.steps.map((s) => (
            <tr key={s.key}>
              <td>{s.position}</td><td>{s.name}</td>
              <td>{ROLE_LABEL[s.role] ?? s.role}{s.scope === "DISTRICT" ? ", own district" : ""}</td>
              <td>{s.requiredApprovals}</td><td>{s.slaMinutes ?? "none"}</td>
              <td>{s.condition ? JSON.stringify(s.condition) : "always"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="settings">
        {Object.entries(config.settings).map(([k, v]) => <li key={k}><code>{k}</code> = <code>{JSON.stringify(v)}</code></li>)}
      </ul>
    </details>
  );
}
