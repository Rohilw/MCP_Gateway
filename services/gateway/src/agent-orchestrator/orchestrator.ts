import { isReadOnlySqlQuery, type SqlResource, type WikiResource } from "@mcp-gateway/shared";
import { buildFinalSummaryPrompt, buildSqlGenerationPrompt, buildToolSelectionPrompt } from "./prompts";
import type {
  AgentChatRequest,
  AgentOrchestrator,
  AgentOrchestratorOptions,
  ExecuteToolInput,
  OrchestratorToolCall,
  SqlSchemaConstraints
} from "./types";

const SQL_SCHEMA_CONSTRAINTS: SqlSchemaConstraints = {
  db: "mcp_gateway",
  schema: "public",
  tables: {
    employees: ["id", "name", "dept", "level"],
    payroll_summary: ["employee_id", "month", "total_comp"]
  },
  blocked_tables: ["payroll_line_items"]
};

const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "group",
  "by",
  "order",
  "limit",
  "having",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "on",
  "and",
  "or",
  "not",
  "as",
  "desc",
  "asc",
  "distinct",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "nullif",
  "case",
  "when",
  "then",
  "else",
  "end",
  "true",
  "false",
  "null",
  "with"
]);

function normalizeIdentifier(value: string): string {
  return value.replace(/"/g, "").trim().toLowerCase();
}

function stripSqlForParsing(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/'([^']|'')*'/g, "''");
}

function extractReferencedTables(sql: string): Set<string> {
  const scrubbed = stripSqlForParsing(sql);
  const pattern = /\b(?:from|join)\s+([a-zA-Z0-9_."$]+)/gi;
  const tables = new Set<string>();

  let match = pattern.exec(scrubbed);
  while (match) {
    const raw = match[1];
    if (raw) {
      const cleaned = raw.replace(/[;,]/g, "").trim();
      const parts = cleaned.split(".").map((part) => normalizeIdentifier(part)).filter(Boolean);
      const table = parts[parts.length - 1];
      if (table) {
        tables.add(table);
      }
    }
    match = pattern.exec(scrubbed);
  }

  return tables;
}

function extractAliases(sql: string): Set<string> {
  const scrubbed = stripSqlForParsing(sql);
  const aliases = new Set<string>();

  const joinAliasPattern = /\b(?:from|join)\s+[a-zA-Z0-9_."$]+\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let aliasMatch = joinAliasPattern.exec(scrubbed);
  while (aliasMatch) {
    const alias = aliasMatch[1];
    if (alias) {
      aliases.add(alias.toLowerCase());
    }
    aliasMatch = joinAliasPattern.exec(scrubbed);
  }

  const selectAliasPattern = /\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  let selectAliasMatch = selectAliasPattern.exec(scrubbed);
  while (selectAliasMatch) {
    const alias = selectAliasMatch[1];
    if (alias) {
      aliases.add(alias.toLowerCase());
    }
    selectAliasMatch = selectAliasPattern.exec(scrubbed);
  }

  return aliases;
}

function extractIdentifiers(sql: string): string[] {
  const scrubbed = stripSqlForParsing(sql);
  const matches = scrubbed.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g);
  if (!matches) {
    return [];
  }
  return matches.map((match) => match.toLowerCase());
}

function validateGeneratedSql(query: string, constraints: SqlSchemaConstraints): { ok: true } | { ok: false; reason: string } {
  if (!isReadOnlySqlQuery(query)) {
    return {
      ok: false,
      reason: "Generated SQL is not a single read-only SELECT statement"
    };
  }

  const loweredQuery = query.toLowerCase();
  for (const blockedTable of constraints.blocked_tables) {
    if (loweredQuery.includes(blockedTable.toLowerCase())) {
      return {
        ok: false,
        reason: `Generated SQL references blocked table '${blockedTable}'`
      };
    }
  }

  const allowedTables = new Set(Object.keys(constraints.tables).map((table) => table.toLowerCase()));
  const referencedTables = extractReferencedTables(query);
  if (referencedTables.size === 0) {
    return {
      ok: false,
      reason: "Generated SQL does not reference an allowed table"
    };
  }
  for (const table of referencedTables) {
    if (!allowedTables.has(table)) {
      return {
        ok: false,
        reason: `Generated SQL references non-allowed table '${table}'`
      };
    }
  }

  const allowedColumns = new Set(
    Object.values(constraints.tables)
      .flat()
      .map((column) => column.toLowerCase())
  );
  const aliases = extractAliases(query);
  const identifiers = extractIdentifiers(query);
  for (const identifier of identifiers) {
    if (SQL_KEYWORDS.has(identifier)) {
      continue;
    }
    if (identifier.length === 1) {
      continue;
    }
    if (identifier === constraints.schema.toLowerCase() || identifier === constraints.db.toLowerCase()) {
      continue;
    }
    if (allowedTables.has(identifier)) {
      continue;
    }
    if (allowedColumns.has(identifier)) {
      continue;
    }
    if (aliases.has(identifier)) {
      continue;
    }
    return {
      ok: false,
      reason: `Generated SQL references non-allowed identifier '${identifier}'`
    };
  }

  return { ok: true };
}

function pickPrimarySqlTable(query: string): string {
  const referencedTables = Array.from(extractReferencedTables(query));
  return referencedTables[0] ?? "employees";
}

function pickWikiPageHint(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("benefit")) {
    return "benefits";
  }
  if (text.includes("runbook") || text.includes("incident") || text.includes("deploy")) {
    return "engineering_runbook";
  }
  if (text.includes("marketing")) {
    return "marketing_guidelines";
  }
  if (text.includes("onboarding") || text.includes("new hire")) {
    return "onboarding";
  }
  return "onboarding";
}

function makeCitationId(toolName: string, index: number): string {
  return `${toolName}#${index}`;
}

export function createAgentOrchestrator(options: AgentOrchestratorOptions): AgentOrchestrator {
  const { llm, executor } = options;

  async function run(request: AgentChatRequest): Promise<{
    answer: string;
    tool_calls: OrchestratorToolCall[];
    prompts_used: {
      tool_selection: string;
      sql_generation?: string;
      final_summary: string;
    };
  }> {
    const actor = {
      user_id: request.user_id ?? "agent-orchestrator",
      bot_role: request.bot_role
    };

    const toolSelectionPrompt = buildToolSelectionPrompt(request.message);
    const toolSelection = await llm.selectTools({
      prompt: toolSelectionPrompt,
      message: request.message
    });

    const toolCalls: OrchestratorToolCall[] = [];
    let sqlGenerationPrompt: string | undefined;

    const plannedTools = Array.from(new Set(toolSelection.tools));

    for (const toolName of plannedTools) {
      if (toolName === "wiki.search") {
        const wikiResource: WikiResource = {
          source: "wiki",
          space: "knowledge",
          page: pickWikiPageHint(request.message)
        };
        const input: ExecuteToolInput = {
          serverName: "wiki",
          toolName: "wiki.search",
          body: {
            resource: wikiResource,
            input: {
              query: request.message,
              limit: 5
            }
          }
        };
        const response = await executor.executeTool({
          actor,
          serverName: input.serverName,
          toolName: input.toolName,
          body: input.body
        });
        toolCalls.push({
          citation_id: makeCitationId(input.toolName, toolCalls.length + 1),
          server_name: input.serverName,
          tool_name: input.toolName,
          request: input,
          response
        });
      }

      if (toolName === "sql.query") {
        sqlGenerationPrompt = buildSqlGenerationPrompt(request.message, SQL_SCHEMA_CONSTRAINTS);
        const sqlDraft = await llm.generateSql({
          prompt: sqlGenerationPrompt,
          message: request.message,
          constraints: SQL_SCHEMA_CONSTRAINTS
        });

        const validation = validateGeneratedSql(sqlDraft.query, SQL_SCHEMA_CONSTRAINTS);
        if (!validation.ok) {
          toolCalls.push({
            citation_id: makeCitationId("sql.query", toolCalls.length + 1),
            server_name: "sql",
            tool_name: "sql.query",
            request: {
              serverName: "sql",
              toolName: "sql.query",
              body: {
                resource: {
                  source: "sql",
                  db: SQL_SCHEMA_CONSTRAINTS.db,
                  schema: SQL_SCHEMA_CONSTRAINTS.schema,
                  table: "employees"
                },
                input: {
                  query: sqlDraft.query,
                  db: SQL_SCHEMA_CONSTRAINTS.db,
                  schema: SQL_SCHEMA_CONSTRAINTS.schema
                }
              }
            },
            response: {
              ok: false,
              statusCode: 500,
              error: "orchestrator_sql_validation_error",
              humanMessage: validation.reason,
              details: sqlDraft.rationale
            }
          });
          continue;
        }

        const primaryTable = pickPrimarySqlTable(sqlDraft.query);
        const sqlResource: SqlResource = {
          source: "sql",
          db: SQL_SCHEMA_CONSTRAINTS.db,
          schema: SQL_SCHEMA_CONSTRAINTS.schema,
          table: primaryTable
        };
        const input: ExecuteToolInput = {
          serverName: "sql",
          toolName: "sql.query",
          body: {
            resource: sqlResource,
            input: {
              query: sqlDraft.query,
              db: SQL_SCHEMA_CONSTRAINTS.db,
              schema: SQL_SCHEMA_CONSTRAINTS.schema
            }
          }
        };
        const response = await executor.executeTool({
          actor,
          serverName: input.serverName,
          toolName: input.toolName,
          body: input.body
        });
        toolCalls.push({
          citation_id: makeCitationId(input.toolName, toolCalls.length + 1),
          server_name: input.serverName,
          tool_name: input.toolName,
          request: input,
          response
        });
      }
    }

    const finalSummaryPrompt = buildFinalSummaryPrompt(request.message, toolCalls);
    const summary = await llm.summarize({
      prompt: finalSummaryPrompt,
      message: request.message,
      toolCalls
    });

    const promptsUsed = sqlGenerationPrompt
      ? {
          tool_selection: toolSelectionPrompt,
          sql_generation: sqlGenerationPrompt,
          final_summary: finalSummaryPrompt
        }
      : {
          tool_selection: toolSelectionPrompt,
          final_summary: finalSummaryPrompt
        };

    return {
      answer: summary.answer,
      tool_calls: toolCalls,
      prompts_used: promptsUsed
    };
  }

  return {
    run
  };
}
