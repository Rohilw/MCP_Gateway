import type { GatewayToolRequestBody } from "@mcp-gateway/shared";
import type { ExecuteMcpToolResult, McpExecutor } from "../mcp-executor";

export interface AgentChatRequest {
  bot_role: string;
  message: string;
  user_id?: string;
}

export interface SqlSchemaConstraints {
  db: string;
  schema: string;
  tables: Record<string, string[]>;
  blocked_tables: string[];
}

export interface ToolSelectionResponse {
  tools: Array<"wiki.search" | "sql.query">;
  rationale: string;
}

export interface SqlGenerationResponse {
  query: string;
  rationale: string;
}

export interface SummaryResponse {
  answer: string;
}

export interface LlmProvider {
  selectTools: (params: { prompt: string; message: string }) => Promise<ToolSelectionResponse>;
  generateSql: (params: {
    prompt: string;
    message: string;
    constraints: SqlSchemaConstraints;
  }) => Promise<SqlGenerationResponse>;
  summarize: (params: {
    prompt: string;
    message: string;
    toolCalls: OrchestratorToolCall[];
  }) => Promise<SummaryResponse>;
}

export interface ExecuteToolInput {
  serverName: string;
  toolName: string;
  body: GatewayToolRequestBody;
}

export interface OrchestratorToolCall {
  citation_id: string;
  server_name: string;
  tool_name: string;
  request: ExecuteToolInput;
  response: ExecuteMcpToolResult;
}

export interface AgentOrchestrator {
  run: (request: AgentChatRequest) => Promise<{
    answer: string;
    tool_calls: OrchestratorToolCall[];
    prompts_used: {
      tool_selection: string;
      sql_generation?: string;
      final_summary: string;
    };
  }>;
}

export interface AgentOrchestratorOptions {
  llm: LlmProvider;
  executor: McpExecutor;
}
