import type { OrchestratorToolCall, SqlSchemaConstraints } from "./types";

export function buildToolSelectionPrompt(message: string): string {
  return [
    "You are a gateway tool planner.",
    "Choose tools from exactly: wiki.search, sql.query.",
    "Use sql.query for quantitative employee/payroll summary questions.",
    "Use wiki.search for policy/procedure/documentation lookup.",
    "You may select both tools.",
    "Return JSON: {\"tools\": [...], \"rationale\": \"...\"}.",
    "",
    `User message: ${message}`
  ].join("\n");
}

export function buildSqlGenerationPrompt(message: string, constraints: SqlSchemaConstraints): string {
  const tableLines = Object.entries(constraints.tables).map(([table, columns]) => {
    return `- ${table}(${columns.join(", ")})`;
  });
  return [
    "You are a SQL generator for a restricted analytics environment.",
    "Return a single SELECT statement only.",
    "Do not emit comments, markdown, or explanations.",
    "Never use blocked tables.",
    "Only use listed tables and columns.",
    "",
    `Database: ${constraints.db}`,
    `Schema: ${constraints.schema}`,
    "Allowed tables and columns:",
    ...tableLines,
    `Blocked tables: ${constraints.blocked_tables.join(", ")}`,
    "",
    `Question: ${message}`
  ].join("\n");
}

export function buildFinalSummaryPrompt(message: string, toolCalls: OrchestratorToolCall[]): string {
  const toolLines = toolCalls.map((toolCall) => {
    return `- ${toolCall.citation_id} ${toolCall.tool_name} => ${toolCall.response.ok ? "ok" : "error"}`;
  });
  return [
    "You are an assistant that summarizes tool outputs.",
    "Ground every claim in tool results and cite using [citation_id].",
    "Do not invent facts missing from tool outputs.",
    "If a tool failed, mention the failure clearly.",
    "",
    `User message: ${message}`,
    "Available tool call citations:",
    ...toolLines
  ].join("\n");
}
