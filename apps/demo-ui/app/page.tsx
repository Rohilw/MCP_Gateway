"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

type BotRole = "HR_BOT" | "MARKETING_BOT";

interface AuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in_seconds: number;
  user_id: string;
  bot_role: BotRole;
}

interface ToolExecutionError {
  ok: false;
  statusCode: number;
  error: string;
  humanMessage: string;
  reasonCode?: string;
  details?: string;
}

interface ToolExecutionSuccess {
  ok: true;
  policyReasonCode: string;
  policyMessage: string;
  result: unknown;
}

type ToolExecutionResponse = ToolExecutionSuccess | ToolExecutionError;

interface AgentToolCall {
  citation_id: string;
  server_name: string;
  tool_name: string;
  request: unknown;
  response: ToolExecutionResponse;
}

interface AgentChatResponse {
  bot_role: string;
  message: string;
  answer: string;
  tool_calls: AgentToolCall[];
  prompts_used: {
    tool_selection: string;
    sql_generation?: string;
    final_summary: string;
  };
}

interface ChatTurn {
  id: number;
  userMessage: string;
  assistantAnswer: string;
  citations: AgentToolCall[];
  blocked: Array<{
    citationId: string;
    reasonCode: string;
    humanMessage: string;
  }>;
  promptsUsed: AgentChatResponse["prompts_used"] | null;
}

interface ApiErrorResponse {
  error?: string;
  reason_code?: string;
  human_message?: string;
  details?: string;
}

const gatewayUrl = process.env["NEXT_PUBLIC_GATEWAY_URL"] ?? "http://localhost:4000";

function summarizeToolOutput(toolCall: AgentToolCall): string {
  if (!toolCall.response.ok) {
    return toolCall.response.humanMessage;
  }

  if (!toolCall.response.result || typeof toolCall.response.result !== "object") {
    return "No structured output";
  }

  const payload = toolCall.response.result as {
    output?: unknown;
  };
  if (!payload.output || typeof payload.output !== "object") {
    return "No tool output body";
  }

  const output = payload.output as {
    hits?: unknown;
    rows?: unknown;
    pages?: unknown;
  };

  if (Array.isArray(output.hits)) {
    return `${output.hits.length} hit(s)`;
  }
  if (Array.isArray(output.rows)) {
    return `${output.rows.length} row(s)`;
  }
  if (Array.isArray(output.pages)) {
    return `${output.pages.length} page(s)`;
  }

  return "Output available";
}

function extractBlocked(citations: AgentToolCall[]): ChatTurn["blocked"] {
  return citations
    .filter((toolCall): toolCall is AgentToolCall & { response: ToolExecutionError } => !toolCall.response.ok)
    .map((toolCall) => ({
      citationId: toolCall.citation_id,
      reasonCode: toolCall.response.reasonCode ?? "UNKNOWN_REASON",
      humanMessage: toolCall.response.humanMessage
    }));
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

export default function Page() {
  const [username, setUsername] = useState("hr_bot_user");
  const [password, setPassword] = useState("hr-demo-2026");
  const [message, setMessage] = useState("Summarize onboarding guidance.");
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [tokenInfo, setTokenInfo] = useState("");
  const [session, setSession] = useState<{ userId: string; botRole: BotRole } | null>(null);

  async function issueToken(): Promise<AuthTokenResponse> {
    const tokenResponse = await fetch(`${gatewayUrl}/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username,
        password
      })
    });

    if (!tokenResponse.ok) {
      throw new Error(await parseErrorResponse(tokenResponse));
    }

    const tokenPayload = (await tokenResponse.json()) as AuthTokenResponse;
    if (tokenPayload.bot_role !== "HR_BOT" && tokenPayload.bot_role !== "MARKETING_BOT") {
      throw new Error(`Unsupported bot role in token response: ${String(tokenPayload.bot_role)}`);
    }
    setSession({
      userId: tokenPayload.user_id,
      botRole: tokenPayload.bot_role
    });
    setTokenInfo(
      `${tokenPayload.token_type} token issued for ${tokenPayload.user_id} (${tokenPayload.bot_role}) (${tokenPayload.expires_in_seconds}s)`
    );
    return tokenPayload;
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setIsSending(true);
    try {
      await issueToken();
    } catch (requestError) {
      const messageText = requestError instanceof Error ? requestError.message : "Failed to issue token";
      setError(messageText);
    } finally {
      setIsSending(false);
    }
  }

  async function handleChat(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Enter a message before sending.");
      return;
    }

    setIsSending(true);
    setMessage("");

    try {
      const tokenPayload = await issueToken();
      const accessToken = tokenPayload.access_token;
      const chatResponse = await fetch(`${gatewayUrl}/agent/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          bot_role: tokenPayload.bot_role,
          message: trimmedMessage,
          user_id: tokenPayload.user_id
        })
      });

      if (!chatResponse.ok) {
        throw new Error(await parseErrorResponse(chatResponse));
      }

      const payload = (await chatResponse.json()) as AgentChatResponse;
      const blocked = extractBlocked(payload.tool_calls);

      const nextTurn: ChatTurn = {
        id: Date.now(),
        userMessage: trimmedMessage,
        assistantAnswer: payload.answer,
        citations: payload.tool_calls,
        blocked,
        promptsUsed: payload.prompts_used
      };
      setChatTurns((previous) => [...previous, nextTurn]);
    } catch (requestError) {
      const messageText = requestError instanceof Error ? requestError.message : "Agent chat failed";
      setError(messageText);
      setMessage(trimmedMessage);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="kicker">Secure AI Gateway</p>
        <h1>Policy-Controlled Assistant</h1>
        <p className="subtitle">Log in with a role and chat.</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Session</h2>
          <Link className="audit-link" href="/audit">
            View Audit Logs
          </Link>
        </div>
        <form className="form inline-form" onSubmit={handleLogin}>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button disabled={isSending} type="submit">
            {isSending ? "Working..." : "Login"}
          </button>
        </form>
        <p className="token-info">
          Demo credentials: <code>hr_bot_user / hr-demo-2026</code> or <code>marketing_bot_user /
          marketing-demo-2026</code>
        </p>
        {session ? <p className="token-info">Session: {session.userId} ({session.botRole})</p> : null}
        {tokenInfo ? <p className="token-info">{tokenInfo}</p> : null}
      </section>

      <section className="panel">
        <h2>Chat</h2>
        <form className="form chat-form" onSubmit={handleChat}>
          <label>
            Message
            <textarea
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask about onboarding policies, benefits, or employee metrics..."
            />
          </label>
          <button disabled={isSending} type="submit">
            {isSending ? "Thinking..." : "Send"}
          </button>
        </form>
      </section>

      {error ? (
        <section className="panel danger">
          <h2>Error</h2>
          <pre>{error}</pre>
        </section>
      ) : null}

      <section className="chat-list">
        {chatTurns.map((turn) => (
          <article className="panel chat-turn" key={turn.id}>
            <p className="label">User</p>
            <p className="bubble user-bubble">{turn.userMessage}</p>

            <p className="label">Assistant</p>
            <p className="bubble assistant-bubble">{turn.assistantAnswer}</p>

            <h3>Citations</h3>
            <ul className="citations">
              {turn.citations.map((citation) => (
                <li key={citation.citation_id}>
                  <code>{citation.citation_id}</code>
                  <span>{citation.tool_name}</span>
                  <span>{summarizeToolOutput(citation)}</span>
                </li>
              ))}
            </ul>

            {turn.blocked.length > 0 ? (
              <div className="blocked-list">
                <h3>Blocked Calls</h3>
                {turn.blocked.map((blocked) => (
                  <p className="blocked-item" key={blocked.citationId}>
                    <code>{blocked.citationId}</code> <strong>{blocked.reasonCode}</strong>: {blocked.humanMessage}
                  </p>
                ))}
              </div>
            ) : null}

            {turn.promptsUsed ? (
              <details className="prompt-details">
                <summary>Prompts Used</summary>
                <p>
                  <strong>Tool selection</strong>
                </p>
                <pre>{turn.promptsUsed.tool_selection}</pre>
                {turn.promptsUsed.sql_generation ? (
                  <>
                    <p>
                      <strong>SQL generation</strong>
                    </p>
                    <pre>{turn.promptsUsed.sql_generation}</pre>
                  </>
                ) : null}
                <p>
                  <strong>Final summary</strong>
                </p>
                <pre>{turn.promptsUsed.final_summary}</pre>
              </details>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  );
}
