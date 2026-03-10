import type { AuditLogRecord } from "@mcp-gateway/shared";
import type { Pool } from "pg";

export interface AuditLogRow {
  id: string;
  timestamp: string;
  actor: string;
  bot_role: string;
  tool_name: string;
  resource: string;
  decision: "allow" | "deny";
  reason: string;
}

export class AuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT NOT NULL,
        bot_role TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        resource TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);
    `);
  }

  public async logDecision(record: AuditLogRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO audit_log (timestamp, actor, bot_role, tool_name, resource, decision, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        record.timestamp,
        record.actor,
        record.bot_role,
        record.tool_name,
        record.resource,
        record.decision,
        record.reason
      ]
    );
  }

  public async listRecent(limit: number): Promise<AuditLogRow[]> {
    const result = await this.pool.query<AuditLogRow>(
      `
        SELECT id, timestamp, actor, bot_role, tool_name, resource, decision, reason
        FROM audit_log
        ORDER BY id DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows;
  }
}
