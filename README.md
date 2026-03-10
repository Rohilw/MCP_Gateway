# MCP Gateway

A local TypeScript monorepo for testing a secure MCP gateway with:

- Gateway API (`services/gateway`)
- SQL MCP server (`services/mcp-sql-server`)
- Wiki MCP server (`services/mcp-wiki-server`)
- Demo UI (`apps/demo-ui`)

## What It Shows

- Token-based auth (`/auth/token`)
- Role-based policy decisions (`allow` / `deny`)
- Audited tool execution (`/audit`)
- Redaction of sensitive fields
- Explainable denial responses for blocked requests

## Local Setup (Postgres Only)

Prerequisites:

- Node.js 20+
- npm 10+
- PostgreSQL running locally on `localhost:5432`

Create DB and user (if needed):

```sql
CREATE USER mcp_user WITH PASSWORD 'mcp_password';
CREATE DATABASE mcp_gateway OWNER mcp_user;
GRANT ALL PRIVILEGES ON DATABASE mcp_gateway TO mcp_user;
```

From repo root:

```bash
npm install
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/001_create_audit_log.sql
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/002_seed_mcp_sql_data.sql
psql "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway" -f infra/postgres/migrations/003_create_user_credentials.sql
npm run dev
```

## URLs

- Demo UI: `http://localhost:3000`
- Gateway health: `http://localhost:4000/health`
- SQL MCP health: `http://localhost:4100/health`
- Wiki MCP health: `http://localhost:4200/health`

## Demo Users

- `hr_bot_user / hr-demo-2026` (`HR_BOT`)
- `marketing_bot_user / marketing-demo-2026` (`MARKETING_BOT`)

## Core Endpoints

- `POST /auth/token`
- `POST /agent/chat`
- `POST /mcp/:server/tools/:toolName`
- `GET /audit?limit=20`

## Policy Summary

- `MARKETING_BOT`: wiki access only
- `HR_BOT`: wiki + restricted SQL access
- Blocked SQL table: `payroll_line_items`

## Useful Commands

- `npm run dev` - start all apps
- `npm run build` - build workspaces
- `npm run lint` - lint workspaces
- `npm run test` - run tests

## Notes

- Full threat notes: `THREAT_MODEL.md`
- Main env template: `.env.example`
