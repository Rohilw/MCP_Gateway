import type { PolicyContext, PolicyDecision } from "./types";

const HR_ALLOWED_TABLES = new Set(["employees", "payroll_summary"]);
const SQL_WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|exec)\b/i;

function allow(reason_code: PolicyDecision["reason_code"], reason: string): PolicyDecision {
  return {
    decision: "allow",
    reason_code,
    reason
  };
}

function deny(reason_code: PolicyDecision["reason_code"], reason: string): PolicyDecision {
  return {
    decision: "deny",
    reason_code,
    reason
  };
}

function stripLeadingSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
}

export function isReadOnlySqlQuery(sql: string): boolean {
  const cleaned = stripLeadingSqlComments(sql);
  if (!cleaned) {
    return false;
  }

  const lowered = cleaned.toLowerCase();
  if (!/^(select|with)\b/.test(lowered)) {
    return false;
  }

  const statements = lowered.split(";").map((statement) => statement.trim()).filter(Boolean);
  if (statements.length > 1) {
    return false;
  }

  if (SQL_WRITE_KEYWORDS.test(lowered)) {
    return false;
  }

  return true;
}

function extractQuery(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as { query?: unknown };
  if (typeof candidate.query !== "string") {
    return null;
  }
  return candidate.query;
}

function extractTable(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as { table?: unknown };
  if (typeof candidate.table !== "string") {
    return null;
  }
  return candidate.table;
}

function normalizeTableName(name: string): string {
  return name.replace(/"/g, "").trim().toLowerCase();
}

export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  const { actor, tool, resource, input } = context;

  if (tool.name.startsWith("sql.") && resource.source !== "sql") {
    return deny("DENY_TOOL_RESOURCE_MISMATCH", "SQL tools require sql resource shape");
  }
  if (tool.name.startsWith("wiki.") && resource.source !== "wiki") {
    return deny("DENY_TOOL_RESOURCE_MISMATCH", "Wiki tools require wiki resource shape");
  }

  if (actor.bot_role === "MARKETING_BOT") {
    if (resource.source !== "wiki") {
      return deny("DENY_SOURCE_NOT_ALLOWED", "MARKETING_BOT can access wiki resources only");
    }
    if (!tool.name.startsWith("wiki.")) {
      return deny("DENY_TOOL_NOT_ALLOWED", "MARKETING_BOT may only use wiki tools");
    }
    return allow("ALLOW_MARKETING_WIKI", "MARKETING_BOT wiki access granted");
  }

  if (actor.bot_role === "HR_BOT") {
    if (resource.source === "wiki") {
      if (!tool.name.startsWith("wiki.")) {
        return deny("DENY_TOOL_NOT_ALLOWED", "HR_BOT wiki resource requires wiki tools");
      }
      return allow("ALLOW_HR_WIKI", "HR_BOT wiki access granted");
    }

    if (!tool.name.startsWith("sql.")) {
      return deny("DENY_TOOL_NOT_ALLOWED", "HR_BOT sql resource requires sql tools");
    }

    if (tool.name === "sql.listSchemas" || tool.name === "sql.listTables") {
      return allow("ALLOW_HR_SQL_METADATA", "HR_BOT SQL metadata access granted");
    }

    if (tool.name === "sql.describeTable") {
      const inputTable = extractTable(input);
      const candidateTable = normalizeTableName(inputTable ?? resource.table);
      if (!HR_ALLOWED_TABLES.has(candidateTable)) {
        return deny(
          "DENY_SQL_TABLE_NOT_ALLOWED",
          "HR_BOT SQL table access is restricted to employees and payroll_summary"
        );
      }
      return allow("ALLOW_HR_SQL_METADATA", "HR_BOT SQL metadata access granted");
    }

    if (tool.name !== "sql.query") {
      return deny(
        "DENY_TOOL_NOT_ALLOWED",
        "HR_BOT SQL access is limited to sql.query, sql.listSchemas, sql.listTables, and sql.describeTable"
      );
    }

    if (!HR_ALLOWED_TABLES.has(normalizeTableName(resource.table))) {
      return deny(
        "DENY_SQL_TABLE_NOT_ALLOWED",
        "HR_BOT SQL table access is restricted to employees and payroll_summary"
      );
    }

    const query = extractQuery(input);
    if (!query) {
      return deny("DENY_SQL_INPUT_INVALID", "sql.query requires input.query");
    }
    if (!isReadOnlySqlQuery(query)) {
      return deny("DENY_SQL_NON_SELECT", "Only read-only SELECT statements are allowed");
    }

    return allow("ALLOW_HR_SQL_SELECT", "HR_BOT read-only SQL access granted");
  }

  return deny("DENY_ROLE_NOT_ALLOWED", `Unsupported bot role: ${actor.bot_role}`);
}
