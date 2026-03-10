# Threat Model

## Scope

System components in scope:

- `services/gateway` (auth, policy, orchestration, audit)
- `services/mcp-sql-server` and `services/mcp-wiki-server`
- Postgres audit storage
- Agent-facing APIs (`/auth/token`, `/mcp/...`, `/agent/chat`, `/audit`)

Trust boundaries:

- Untrusted agent/user input into gateway
- Gateway to MCP server network boundary
- MCP server to Postgres boundary

## Threats And Mitigations

### Prompt injection

Risk:
- User message can try to steer tool selection/SQL generation toward unsafe actions or hidden instructions.

Mitigations:
- Policy engine enforces role/tool/resource constraints independently of prompt output.
- SQL path enforces read-only single-`SELECT` checks at gateway policy and SQL server.
- SQL table allowlists block `payroll_line_items`.
- Orchestrator SQL validator enforces allowed tables/columns before execution.

Residual risk:
- Injection can still degrade response quality or produce misleading summaries.

### Data exfiltration

Risk:
- Agent could try to retrieve sensitive fields (`tax_id`, `bank_account`) through direct or indirect tool output.

Mitigations:
- Policy prevents access to non-allowed SQL resources.
- SQL server allowlist prevents querying blocked tables.
- Gateway response redaction masks leaked `tax_id` and `bank_account` fields before returning results.
- Audit logs retain access decisions for forensic review.

Residual risk:
- Redaction is key-based/pattern-based and cannot guarantee semantic masking of all sensitive free text.

### Tool misuse

Risk:
- Calls to unregistered tools/servers, cross-source resource confusion, or replayed internal calls.

Mitigations:
- Gateway registry enforces allowed `server -> tools`.
- Gateway denies tool/resource source mismatch.
- MCP servers verify HMAC request signatures from gateway.
- MCP servers reject stale signatures and replayed nonces.
- Optional mTLS can enforce authenticated transport between gateway and MCP servers.

Residual risk:
- Compromised gateway with valid secret/cert can still issue signed requests.

### Overbroad permissions

Risk:
- Bots receive broader access than intended (role confusion, excessive grants).

Mitigations:
- JWT includes `bot_role`; gateway validates token and role.
- `/agent/chat` requires JWT and enforces body `bot_role` equals token `bot_role`.
- Policy rules:
  - `MARKETING_BOT`: wiki-only
  - `HR_BOT`: wiki + restricted SQL tables, read-only SQL

Residual risk:
- Policy bugs or incorrect registry configuration can expand effective permissions.

### Audit integrity

Risk:
- Missing/tampered audit events reduce detectability and accountability.

Mitigations:
- Gateway writes allow/deny decisions to Postgres for every policy check.
- Audit record includes timestamp, actor, bot role, tool, resource, decision, reason.
- `/audit` endpoint enables operational review.

Residual risk:
- Audit table is mutable by privileged DB access; stronger integrity can be added with append-only storage, checksums, and restricted DB roles.

## Additional Hardening Recommendations

- Rotate `JWT_SECRET` and `MCP_HMAC_SECRET` regularly and store in a secret manager.
- Use short network ACLs so only gateway can reach MCP server `/mcp/call`.
- Enable mTLS in non-local environments.
- Add anomaly alerts for repeated denies, replay attempts, and rate-limit spikes.
- Protect Postgres credentials and enforce least-privilege DB roles.
