"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type BotRole = "HR_BOT" | "MARKETING_BOT";

interface AuditRow {
  id: string | number;
  timestamp: string;
  actor: string;
  bot_role: string;
  tool_name: string;
  resource: string;
  decision: "allow" | "deny";
  reason: string;
}

interface AuditResponse {
  items: AuditRow[];
}

const gatewayUrl = process.env["NEXT_PUBLIC_GATEWAY_URL"] ?? "http://localhost:4000";
const SESSION_ROLE_KEY = "mcp_demo_bot_role";
const SESSION_USER_KEY = "mcp_demo_user_id";

function isBotRole(value: string | null): value is BotRole {
  return value === "HR_BOT" || value === "MARKETING_BOT";
}

function formatResource(resource: string): string {
  try {
    const parsed = JSON.parse(resource) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return resource;
  }
}

interface ApiErrorResponse {
  error?: string;
  reason_code?: string;
  human_message?: string;
  details?: string;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as ApiErrorResponse;
    const reason = parsed.reason_code ? ` (${parsed.reason_code})` : "";
    const human = parsed.human_message ?? parsed.error ?? raw;
    const details = parsed.details ? ` - ${parsed.details}` : "";
    return `${human}${reason}${details}`;
  } catch {
    return raw;
  }
}

export default function AuditPage() {
  const [limit, setLimit] = useState(20);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeSession, setActiveSession] = useState<{ userId: string; botRole: BotRole } | null>(null);

  const rowCountLabel = useMemo(() => `${rows.length} row(s)`, [rows.length]);

  const fetchAudit = useCallback(async (currentLimit: number): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${gatewayUrl}/audit?limit=${currentLimit}`);
      if (!response.ok) {
        throw new Error(await parseErrorResponse(response));
      }
      const payload = (await response.json()) as AuditResponse;
      setRows(payload.items);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Failed to fetch audit logs";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAudit(limit);
  }, [fetchAudit, limit]);

  useEffect(() => {
    const storedRole = window.localStorage.getItem(SESSION_ROLE_KEY);
    const storedUser = window.localStorage.getItem(SESSION_USER_KEY);
    if (isBotRole(storedRole) && storedUser) {
      setActiveSession({
        userId: storedUser,
        botRole: storedRole
      });
    }
  }, []);

  return (
    <main className="page">
      <section className="hero">
        <p className="kicker">Secure AI Gateway</p>
        <h1>Audit Logs</h1>
        <p className="subtitle">Inspect recent allow/deny decisions recorded by the gateway.</p>
        <p className={activeSession ? "role-pill role-pill-active" : "role-pill"}>
          Active Role:{" "}
          {activeSession ? (
            <>
              <strong>{activeSession.botRole}</strong> ({activeSession.userId})
            </>
          ) : (
            "Not signed in"
          )}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Audit Feed</h2>
          <Link className="audit-link" href="/">
            Back To Chat
          </Link>
        </div>

        <div className="audit-toolbar">
          <label>
            Limit
            <select
              value={limit}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isInteger(parsed) && parsed > 0) {
                  setLimit(parsed);
                }
              }}
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <button disabled={loading} onClick={() => void fetchAudit(limit)} type="button">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <p className="token-info">{rowCountLabel}</p>
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Role</th>
                <th>Tool</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.timestamp).toLocaleString()}</td>
                  <td>{row.actor}</td>
                  <td>{row.bot_role}</td>
                  <td>
                    <code>{row.tool_name}</code>
                  </td>
                  <td>
                    <span className={row.decision === "deny" ? "badge badge-deny" : "badge badge-allow"}>
                      {row.decision}
                    </span>
                  </td>
                  <td>{row.reason}</td>
                  <td>
                    <details>
                      <summary>view</summary>
                      <pre>{formatResource(row.resource)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
