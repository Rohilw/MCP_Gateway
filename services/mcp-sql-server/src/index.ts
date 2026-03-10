import fs from "node:fs";
import Fastify from "fastify";
import { Pool, type FieldDef, type QueryResult } from "pg";
import {
  MCP_SIGNATURE_VERSION,
  NonceReplayGuard,
  verifyMcpRequestSignature
} from "@mcp-gateway/shared";

interface McpSqlCallBody {
  tool_name: string;
  resource: SqlResource;
  input: unknown;
  actor: string;
  bot_role: string;
}

interface SqlResource {
  source: "sql";
  db: string;
  schema: string;
  table: string;
}

interface ListSchemasInput {
  db: string;
}

interface ListTablesInput {
  db: string;
  schema: string;
}

interface DescribeTableInput {
  db: string;
  schema: string;
  table: string;
}

interface SqlQueryInput {
  query: string;
  db: string;
  schema: string;
}

const ALLOWED_TABLES = new Set(["employees", "payroll_summary"]);
const WRITE_SQL_PATTERN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|exec|copy)\b/i;

function normalizeIdentifier(value: string): string {
  return value.replace(/"/g, "").trim().toLowerCase();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
}

function isSingleSelectStatement(sql: string): boolean {
  const cleaned = stripSqlComments(sql);
  if (!cleaned) {
    return false;
  }

  const lowered = cleaned.toLowerCase();
  if (!/^(select|with)\b/.test(lowered)) {
    return false;
  }

  const statements = lowered
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length !== 1) {
    return false;
  }

  if (WRITE_SQL_PATTERN.test(lowered)) {
    return false;
  }

  return true;
}

function extractReferencedTables(sql: string): Set<string> {
  const tables = new Set<string>();
  const scrubbed = stripSqlComments(sql).replace(/'([^']|'')*'/g, "''");
  const relationPattern = /\b(?:from|join)\s+([a-zA-Z0-9_."$]+)/gi;

  let match = relationPattern.exec(scrubbed);
  while (match) {
    const rawToken = match[1];
    if (rawToken) {
      const token = rawToken.replace(/[;,]/g, "").trim();
      if (token.length > 0 && !token.startsWith("(")) {
        const parts = token.split(".").map((part) => normalizeIdentifier(part)).filter(Boolean);
        const tableName = parts[parts.length - 1];
        if (tableName) {
          tables.add(tableName);
        }
      }
    }
    match = relationPattern.exec(scrubbed);
  }

  return tables;
}

function formatResult(result: QueryResult<Record<string, unknown>>): {
  columns: Array<{ name: string; dataTypeId: number; tableId: number }>;
  rows: Record<string, unknown>[];
  rowCount: number;
} {
  const columns = result.fields.map((field: FieldDef) => ({
    name: field.name,
    dataTypeId: field.dataTypeID,
    tableId: field.tableID
  }));

  return {
    columns,
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length
  };
}

function isSqlResource(value: unknown): value is SqlResource {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SqlResource;
  return (
    candidate.source === "sql" &&
    typeof candidate.db === "string" &&
    typeof candidate.schema === "string" &&
    typeof candidate.table === "string"
  );
}

function isMcpSqlCallBody(value: unknown): value is McpSqlCallBody {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    tool_name?: unknown;
    resource?: unknown;
    input?: unknown;
    actor?: unknown;
    bot_role?: unknown;
  };
  return (
    typeof candidate.tool_name === "string" &&
    isSqlResource(candidate.resource) &&
    typeof candidate.actor === "string" &&
    typeof candidate.bot_role === "string" &&
    Object.prototype.hasOwnProperty.call(candidate, "input")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStringField(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  return typeof value === "string" ? value : null;
}

function parseListSchemasInput(value: unknown): ListSchemasInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const db = getStringField(record, "db");
  if (!db) {
    return null;
  }
  return { db };
}

function parseListTablesInput(value: unknown): ListTablesInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const db = getStringField(record, "db");
  const schema = getStringField(record, "schema");
  if (!db || !schema) {
    return null;
  }
  return { db, schema };
}

function parseDescribeTableInput(value: unknown): DescribeTableInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const db = getStringField(record, "db");
  const schema = getStringField(record, "schema");
  const table = getStringField(record, "table");
  if (!db || !schema || !table) {
    return null;
  }
  return { db, schema, table };
}

function parseSqlQueryInput(value: unknown): SqlQueryInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const query = getStringField(record, "query");
  const db = getStringField(record, "db");
  const schema = getStringField(record, "schema");
  if (!query || !db || !schema) {
    return null;
  }
  return { query, db, schema };
}

function ensureDbMatches(requestedDb: string, configuredDb: string): { ok: true } | { ok: false; reason: string } {
  if (normalizeIdentifier(requestedDb) !== normalizeIdentifier(configuredDb)) {
    return {
      ok: false,
      reason: `Requested db '${requestedDb}' does not match configured db '${configuredDb}'`
    };
  }
  return { ok: true };
}

function ensureResourceAlignment(
  resource: SqlResource,
  input: { db: string; schema?: string; table?: string }
): { ok: true } | { ok: false; reason: string } {
  if (normalizeIdentifier(resource.db) !== normalizeIdentifier(input.db)) {
    return {
      ok: false,
      reason: "resource.db must match input.db"
    };
  }
  if (input.schema && normalizeIdentifier(resource.schema) !== normalizeIdentifier(input.schema)) {
    return {
      ok: false,
      reason: "resource.schema must match input.schema"
    };
  }
  if (input.table && normalizeIdentifier(resource.table) !== normalizeIdentifier(input.table)) {
    return {
      ok: false,
      reason: "resource.table must match input.table"
    };
  }
  return { ok: true };
}

function deny(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, reasonCode: string, message: string): unknown {
  return reply.status(403).send({
    error: "forbidden",
    reason_code: reasonCode,
    human_message: message
  });
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return parsed;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function buildHttpsOptions(): {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  requestCert: boolean;
  rejectUnauthorized: boolean;
} {
  const certFile = process.env["TLS_CERT_FILE"];
  const keyFile = process.env["TLS_KEY_FILE"];
  const caFile = process.env["TLS_CA_FILE"];
  const requireClientCert = parseBoolean(process.env["TLS_REQUIRE_CLIENT_CERT"], true);

  if (!certFile || !keyFile) {
    throw new Error("TLS_ENABLED=true requires TLS_CERT_FILE and TLS_KEY_FILE");
  }
  if (requireClientCert && !caFile) {
    throw new Error("TLS_REQUIRE_CLIENT_CERT=true requires TLS_CA_FILE");
  }

  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
    ...(caFile ? { ca: fs.readFileSync(caFile) } : {}),
    requestCert: requireClientCert,
    rejectUnauthorized: requireClientCert
  };
}

async function start(): Promise<void> {
  const tlsEnabled = parseBoolean(process.env["TLS_ENABLED"], false);
  const serverOptions = (
    tlsEnabled
      ? {
          logger: true,
          https: buildHttpsOptions()
        }
      : {
          logger: true
        }
  ) as Parameters<typeof Fastify>[0];
  const server = Fastify(serverOptions);
  const port = Number(process.env["PORT"] ?? "4100");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid PORT value");
  }

  const mcpHmacSecret = process.env["MCP_HMAC_SECRET"] ?? "dev-only-change-me-hmac";
  const signatureToleranceMs = parsePositiveInteger(
    process.env["MCP_SIGNATURE_TOLERANCE_MS"],
    300_000,
    "MCP_SIGNATURE_TOLERANCE_MS"
  );
  const nonceReplayGuard = new NonceReplayGuard(signatureToleranceMs);

  const configuredDatabase = process.env["PGDATABASE"] ?? "mcp_gateway";
  const pool = new Pool({
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? "5432"),
    user: process.env["PGUSER"] ?? "mcp_user",
    password: process.env["PGPASSWORD"] ?? "mcp_password",
    database: configuredDatabase
  });

  server.addHook("onClose", async () => {
    await pool.end();
  });

  server.get("/health", async () => ({ status: "ok" }));

  server.post<{ Body: unknown }>("/mcp/call", async (request, reply) => {
    const signatureVersion = firstHeaderValue(request.headers["x-mcp-signature-version"]);
    if (signatureVersion !== MCP_SIGNATURE_VERSION) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: "DENY_MCP_SIGNATURE_INVALID",
        human_message: "Unsupported MCP signature version"
      });
    }

    const signatureCheck = verifyMcpRequestSignature({
      secret: mcpHmacSecret,
      timestamp: firstHeaderValue(request.headers["x-mcp-timestamp"]),
      nonce: firstHeaderValue(request.headers["x-mcp-nonce"]),
      signature: firstHeaderValue(request.headers["x-mcp-signature"]),
      payload: request.body,
      maxSkewMs: signatureToleranceMs
    });
    if (!signatureCheck.ok) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: signatureCheck.reason_code,
        human_message: signatureCheck.reason
      });
    }
    if (nonceReplayGuard.isReplay(signatureCheck.nonce)) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: "DENY_MCP_SIGNATURE_REPLAY",
        human_message: "Signed request nonce has already been used"
      });
    }

    if (!isMcpSqlCallBody(request.body)) {
      return reply.status(400).send({
        error: "bad_request",
        human_message: "Invalid body. Expected sql resource {source,db,schema,table}"
      });
    }

    const { tool_name: toolNameRaw, resource, input, actor, bot_role: botRole } = request.body;
    const toolName = toolNameRaw;

    if (toolName === "sql.listSchemas") {
      const parsed = parseListSchemasInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "sql.listSchemas expects input: { db }"
        });
      }

      const dbCheck = ensureDbMatches(parsed.db, configuredDatabase);
      if (!dbCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: dbCheck.reason
        });
      }
      const resourceCheck = ensureResourceAlignment(resource, {
        db: parsed.db
      });
      if (!resourceCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: resourceCheck.reason
        });
      }

      const result = await pool.query<Record<string, unknown>>(
        `
          SELECT DISTINCT t.table_schema AS schema_name
          FROM information_schema.tables t
          WHERE t.table_catalog = $1
            AND t.table_type = 'BASE TABLE'
            AND t.table_name = ANY($2::text[])
          ORDER BY t.table_schema
        `,
        [configuredDatabase, Array.from(ALLOWED_TABLES)]
      );

      return reply.send({
        server: "mcp-sql-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: formatResult(result)
      });
    }

    if (toolName === "sql.listTables") {
      const parsed = parseListTablesInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "sql.listTables expects input: { db, schema }"
        });
      }

      const dbCheck = ensureDbMatches(parsed.db, configuredDatabase);
      if (!dbCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: dbCheck.reason
        });
      }
      const resourceCheck = ensureResourceAlignment(resource, {
        db: parsed.db,
        schema: parsed.schema
      });
      if (!resourceCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: resourceCheck.reason
        });
      }

      const result = await pool.query<Record<string, unknown>>(
        `
          SELECT t.table_name
          FROM information_schema.tables t
          WHERE t.table_catalog = $1
            AND t.table_schema = $2
            AND t.table_type = 'BASE TABLE'
            AND t.table_name = ANY($3::text[])
          ORDER BY t.table_name
        `,
        [configuredDatabase, parsed.schema, Array.from(ALLOWED_TABLES)]
      );

      return reply.send({
        server: "mcp-sql-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: formatResult(result)
      });
    }

    if (toolName === "sql.describeTable") {
      const parsed = parseDescribeTableInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "sql.describeTable expects input: { db, schema, table }"
        });
      }

      const dbCheck = ensureDbMatches(parsed.db, configuredDatabase);
      if (!dbCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: dbCheck.reason
        });
      }
      const resourceCheck = ensureResourceAlignment(resource, {
        db: parsed.db,
        schema: parsed.schema,
        table: parsed.table
      });
      if (!resourceCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: resourceCheck.reason
        });
      }

      const normalizedTable = normalizeIdentifier(parsed.table);
      if (!ALLOWED_TABLES.has(normalizedTable)) {
        return deny(
          reply,
          "DENY_SQL_TABLE_NOT_ALLOWED",
          `Table '${parsed.table}' is not in the SQL allowlist`
        );
      }

      const result = await pool.query<Record<string, unknown>>(
        `
          SELECT c.column_name, c.data_type, c.is_nullable, c.ordinal_position
          FROM information_schema.columns c
          WHERE c.table_catalog = $1
            AND c.table_schema = $2
            AND c.table_name = $3
          ORDER BY c.ordinal_position
        `,
        [configuredDatabase, parsed.schema, parsed.table]
      );

      return reply.send({
        server: "mcp-sql-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: formatResult(result)
      });
    }

    if (toolName === "sql.query") {
      const parsed = parseSqlQueryInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "sql.query expects input: { query, db, schema }"
        });
      }

      const dbCheck = ensureDbMatches(parsed.db, configuredDatabase);
      if (!dbCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: dbCheck.reason
        });
      }
      const resourceCheck = ensureResourceAlignment(resource, {
        db: parsed.db,
        schema: parsed.schema
      });
      if (!resourceCheck.ok) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: resourceCheck.reason
        });
      }

      if (!isSingleSelectStatement(parsed.query)) {
        return deny(
          reply,
          "DENY_SQL_NON_SELECT",
          "sql.query only allows a single read-only SELECT statement"
        );
      }

      const referencedTables = extractReferencedTables(parsed.query);
      for (const table of referencedTables) {
        if (!ALLOWED_TABLES.has(table)) {
          return deny(
            reply,
            "DENY_SQL_TABLE_NOT_ALLOWED",
            `Query references table '${table}', which is not in the SQL allowlist`
          );
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${quoteIdentifier(parsed.schema)}, public`);
        await client.query("SET TRANSACTION READ ONLY");
        const result = await client.query<Record<string, unknown>>(parsed.query);
        await client.query("COMMIT");

        return reply.send({
          server: "mcp-sql-server",
          tool_name: toolName,
          actor,
          bot_role: botRole,
          resource,
          output: formatResult(result)
        });
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Ignore rollback failures and rethrow original error.
        }
        throw error;
      } finally {
        client.release();
      }
    }

    return reply.status(400).send({
      error: "bad_request",
      human_message: `Unsupported SQL MCP tool: ${toolNameRaw}`
    });
  });

  await server.listen({
    host: "0.0.0.0",
    port
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
