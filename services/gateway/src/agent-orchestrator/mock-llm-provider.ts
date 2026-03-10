import type { ExecuteMcpToolResult } from "../mcp-executor";
import type {
  LlmProvider,
  OrchestratorToolCall,
  SqlGenerationResponse,
  SqlSchemaConstraints,
  SummaryResponse,
  ToolSelectionResponse
} from "./types";

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeMessage(message: string): string {
  return message.toLowerCase();
}

function extractRowsFromToolResult(result: ExecuteMcpToolResult): unknown[] {
  if (!result.ok) {
    return [];
  }
  if (!result.result || typeof result.result !== "object") {
    return [];
  }
  const serverPayload = result.result as {
    output?: unknown;
  };
  if (!serverPayload.output || typeof serverPayload.output !== "object") {
    return [];
  }
  const output = serverPayload.output as {
    rows?: unknown;
  };
  return Array.isArray(output.rows) ? output.rows : [];
}

function extractHitsFromToolResult(result: ExecuteMcpToolResult): unknown[] {
  if (!result.ok) {
    return [];
  }
  if (!result.result || typeof result.result !== "object") {
    return [];
  }
  const serverPayload = result.result as {
    output?: unknown;
  };
  if (!serverPayload.output || typeof serverPayload.output !== "object") {
    return [];
  }
  const output = serverPayload.output as {
    hits?: unknown;
  };
  return Array.isArray(output.hits) ? output.hits : [];
}

function stringifyRow(row: unknown): string {
  if (!row || typeof row !== "object") {
    return String(row);
  }
  const entries = Object.entries(row as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`);
  return entries.join(", ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatHeadcountSummary(rows: unknown[]): string | null {
  const pairs: Array<{ dept: string; count: number }> = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) {
      return null;
    }
    const dept = record["dept"];
    const employeeCount = asNumberLike(record["employee_count"]);
    if (typeof dept !== "string" || dept.trim().length === 0 || employeeCount === null) {
      return null;
    }
    pairs.push({
      dept: dept.trim(),
      count: employeeCount
    });
  }

  if (pairs.length === 0) {
    return null;
  }

  const summary = pairs.map((pair) => `${pair.dept}: ${pair.count}`).join("; ");
  return `Employee headcount by department: ${summary}.`;
}

function formatGenericSqlSummary(rows: unknown[]): string {
  const preview = rows
    .slice(0, 3)
    .map((row) => stringifyRow(row))
    .join("; ");
  return `SQL query returned ${rows.length} row(s). Top rows: ${preview}.`;
}

export class MockLlmProvider implements LlmProvider {
  public async selectTools(params: { prompt: string; message: string }): Promise<ToolSelectionResponse> {
    const message = normalizeMessage(params.message);
    const wikiKeywords = [
      "wiki",
      "onboarding",
      "benefits",
      "runbook",
      "guideline",
      "policy",
      "handbook",
      "how do",
      "documentation"
    ];
    const sqlKeywords = [
      "employee",
      "employees",
      "dept",
      "department",
      "level",
      "headcount",
      "count",
      "payroll",
      "compensation",
      "total comp",
      "summary"
    ];

    const useWiki = hasAnyKeyword(message, wikiKeywords);
    const useSql = hasAnyKeyword(message, sqlKeywords);

    const tools: ToolSelectionResponse["tools"] = [];
    if (useWiki || !useSql) {
      tools.push("wiki.search");
    }
    if (useSql) {
      tools.push("sql.query");
    }

    return {
      tools,
      rationale: `Selected tools deterministically from keyword matches (${tools.join(", ")}).`
    };
  }

  public async generateSql(params: {
    prompt: string;
    message: string;
    constraints: SqlSchemaConstraints;
  }): Promise<SqlGenerationResponse> {
    const message = normalizeMessage(params.message);
    const db = params.constraints.db;
    const schema = params.constraints.schema;
    const employees = `${schema}.employees`;
    const payrollSummary = `${schema}.payroll_summary`;

    if (message.includes("headcount") || message.includes("how many")) {
      return {
        query: `SELECT dept, COUNT(*) AS employee_count FROM ${employees} GROUP BY dept ORDER BY dept`,
        rationale: "Headcount intent maps to grouped employee count."
      };
    }

    if (message.includes("payroll") || message.includes("compensation") || message.includes("total comp")) {
      return {
        query: `SELECT employee_id, month, total_comp FROM ${payrollSummary} ORDER BY month DESC, employee_id`,
        rationale: "Compensation intent maps to payroll_summary table."
      };
    }

    if (message.includes("level") || message.includes("department") || message.includes("dept")) {
      return {
        query: `SELECT id, name, dept, level FROM ${employees} ORDER BY dept, name`,
        rationale: "Org profile intent maps to employees table."
      };
    }

    return {
      query: `SELECT id, name, dept, level FROM ${employees} ORDER BY id LIMIT 10`,
      rationale: `Default deterministic query for db=${db}, schema=${schema}.`
    };
  }

  public async summarize(params: {
    prompt: string;
    message: string;
    toolCalls: OrchestratorToolCall[];
  }): Promise<SummaryResponse> {
    const lines: string[] = [];
    for (const toolCall of params.toolCalls) {
      if (!toolCall.response.ok) {
        lines.push(
          `Tool ${toolCall.tool_name} failed: ${toolCall.response.humanMessage} [${toolCall.citation_id}]`
        );
        continue;
      }

      if (toolCall.tool_name === "wiki.search") {
        const hits = extractHitsFromToolResult(toolCall.response);
        if (hits.length === 0) {
          lines.push(`Wiki search returned no hits [${toolCall.citation_id}]`);
        } else {
          const top = stringifyRow(hits[0]);
          lines.push(`Wiki search found ${hits.length} relevant entries; top hit: ${top} [${toolCall.citation_id}]`);
        }
        continue;
      }

      if (toolCall.tool_name === "sql.query") {
        const rows = extractRowsFromToolResult(toolCall.response);
        if (rows.length === 0) {
          lines.push(`SQL query returned no rows [${toolCall.citation_id}]`);
        } else {
          const headcountSummary = formatHeadcountSummary(rows);
          const summary = headcountSummary ?? formatGenericSqlSummary(rows);
          lines.push(`${summary} [${toolCall.citation_id}]`);
        }
        continue;
      }

      lines.push(`Tool ${toolCall.tool_name} completed [${toolCall.citation_id}]`);
    }

    const answer =
      lines.length > 0
        ? lines.join("\n")
        : "No tool outputs were available to summarize.";

    return {
      answer
    };
  }
}
