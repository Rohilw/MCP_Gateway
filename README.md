# MCP Gateway

`mcp-gateway` is a TypeScript monorepo that demonstrates how to put a secure gateway in front of MCP tool servers.
It includes authentication, policy enforcement, audited tool execution, request signing, and a demo UI.

## Highlights

- Short-lived JWT auth (`/auth/token`, 5-minute expiry).
- Role-based policy checks before every tool call.
- Strict tool routing via a server registry (`server -> allowed tools`).
- Gateway-to-MCP HMAC signing with timestamp and nonce replay protection.
- Optional mTLS support between gateway and MCP servers.
- Sensitive-field redaction (`tax_id`, `bank_account`) in gateway responses.
- Postgres-backed audit logs (`allow` and `deny` decisions).
- Deterministic `/agent/chat` orchestrator that uses the same gateway policy path.

## Architecture

```text
Browser / Agent
    |
    v
Gateway (auth + policy + rate limit + audit + routing + redaction)
    |                                  |
    | signed MCP calls                 | Postgres
    v                                  |   - audit_log
MCP SQL Server                         |   - user_credentials
MCP Wiki Server                        |
    |                                  |
    v                                  v
Postgres SQL data                 Markdown wiki pages
```

## Repository Layout

```text
apps/
  demo-ui/                 # Next.js demo app
infra/
  docker-compose.yml       # Local stack
  Dockerfile.dev
  postgres/
    init.sql               # Full bootstrap for Docker
    migrations/
packages/
  shared/                  # Shared auth/policy/signing utilities + tests
services/
  gateway/                 # Fastify gateway
  mcp-sql-server/          # SQL MCP server
  mcp-wiki-server/         # Wiki MCP server
THREAT_MODEL.md
```

## Quickstart (Docker)

Prerequisite: Docker Desktop (or Docker Engine + Compose plugin).

```bash
docker compose -f infra/docker-compose.yml up --build
```

After startup:

- Demo UI: `http://localhost:3000`
- Gateway: `http://localhost:4000`
- SQL MCP server: `http://localhost:4100`
- Wiki MCP server: `http://localhost:4200`
- Postgres: `localhost:5432`

Demo credentials:

- `hr_bot_user / hr-demo-2026` -> `user-001`, `HR_BOT`
- `marketing_bot_user / marketing-demo-2026` -> `user-002`, `MARKETING_BOT`

## Local Development (Without Docker)

Prerequisites:

- Node.js 20+
- npm 10+
- Postgres 16+ running locally

Install dependencies:

```bash
npm install
```

Create schema and seed data:

```bash
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/001_create_audit_log.sql
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/002_seed_mcp_sql_data.sql
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/003_create_user_credentials.sql
```

Set environment variables from `.env.example`, then start all apps:

```bash
npm run dev
```

## Main Endpoints

Gateway:

- `GET /health`
- `POST /auth/token`
- `POST /mcp/:server/tools/:toolName`
- `POST /agent/chat`
- `GET /audit?limit=20`

MCP servers:

- SQL server: `GET /health`, `POST /mcp/call`
- Wiki server: `GET /health`, `POST /mcp/call`

## API Examples

Issue token:

```bash
curl -X POST http://localhost:4000/auth/token \
  -H "content-type: application/json" \
  -d '{"username":"hr_bot_user","password":"hr-demo-2026"}'
```

Run wiki search through gateway:

```bash
curl -X POST http://localhost:4000/mcp/wiki/tools/wiki.search \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "resource":{"source":"wiki","space":"knowledge","page":"onboarding"},
    "input":{"query":"onboarding","limit":5}
  }'
```

Run SQL query through gateway:

```bash
curl -X POST http://localhost:4000/mcp/sql/tools/sql.query \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "resource":{"source":"sql","db":"mcp_gateway","schema":"public","table":"employees"},
    "input":{
      "query":"SELECT id, name, dept, level FROM employees ORDER BY id",
      "db":"mcp_gateway",
      "schema":"public"
    }
  }'
```

Agent orchestration:

```bash
curl -X POST http://localhost:4000/agent/chat \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "bot_role":"HR_BOT",
    "message":"Summarize onboarding guidance and show employee headcount by department"
  }'
```

Read audit logs:

```bash
curl "http://localhost:4000/audit?limit=20"
```

## Policy Model

Roles:

- `MARKETING_BOT`: wiki tools only.
- `HR_BOT`: wiki tools plus restricted SQL tools.

SQL restrictions:

- Only read-only single-statement `SELECT` queries are allowed.
- Allowed tables: `employees`, `payroll_summary`.
- `payroll_line_items` is intentionally blocked.

Additional enforcement:

- `server` and `tool` must both exist in `services/gateway/config/server-registry.json`.
- `resource.source` must match the requested server (`sql` or `wiki`).

## Security Controls

- JWT-based auth with short token lifetime.
- Per-token rate limiting in gateway (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`).
- HMAC-signed gateway-to-MCP requests:
  - `x-mcp-signature-version`
  - `x-mcp-signature`
  - `x-mcp-timestamp`
  - `x-mcp-nonce`
- MCP-side replay protection via nonce cache.
- Optional mTLS between gateway and MCP servers.
- Response redaction for sensitive fields.

Threats, mitigations, and residual risks are documented in `THREAT_MODEL.md`.

## Environment Variables

Core variables (see `.env.example` for full list):

- `JWT_SECRET`
- `MCP_HMAC_SECRET`
- `POSTGRES_URL`
- `MCP_SQL_SERVER_URL`
- `MCP_WIKI_SERVER_URL`
- `SERVER_REGISTRY_FILE`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `MCP_SIGNATURE_TOLERANCE_MS`
- `NEXT_PUBLIC_GATEWAY_URL`

mTLS-related variables:

- `MCP_MTLS_ENABLED`
- `MCP_MTLS_CERT_FILE`
- `MCP_MTLS_KEY_FILE`
- `MCP_MTLS_CA_FILE`
- `MCP_MTLS_REJECT_UNAUTHORIZED`
- `TLS_ENABLED`
- `TLS_CERT_FILE`
- `TLS_KEY_FILE`
- `TLS_CA_FILE`
- `TLS_REQUIRE_CLIENT_CERT`

## Workspace Scripts

From repository root:

- `npm run dev` - run gateway, MCP servers, and demo UI.
- `npm run build` - build all workspaces.
- `npm run lint` - lint all workspaces.
- `npm run test` - run workspace tests (`packages/shared` includes policy/signing tests).

## Notes

- Gateway redaction is key-based and not a full DLP system.
- This project is intended as a secure demo/reference implementation, not a drop-in production platform.
