export interface AgentTokenClaims {
  sub: string;
  bot_role: string;
  scopes?: string[];
}

export type BotRole = "HR_BOT" | "MARKETING_BOT" | string;

export interface ActorContext {
  user_id: string;
  bot_role: BotRole;
}

export interface ToolContext {
  name: string;
}

export interface SqlResource {
  source: "sql";
  db: string;
  schema: string;
  table: string;
}

export interface WikiResource {
  source: "wiki";
  space: string;
  page: string;
}

export type StructuredResource = SqlResource | WikiResource;

export interface PolicyContext {
  actor: ActorContext;
  tool: ToolContext;
  resource: StructuredResource;
  input: unknown;
}

export type PolicyReasonCode =
  | "ALLOW_MARKETING_WIKI"
  | "ALLOW_HR_WIKI"
  | "ALLOW_HR_SQL_METADATA"
  | "ALLOW_HR_SQL_SELECT"
  | "DENY_ROLE_NOT_ALLOWED"
  | "DENY_SOURCE_NOT_ALLOWED"
  | "DENY_TOOL_NOT_ALLOWED"
  | "DENY_TOOL_RESOURCE_MISMATCH"
  | "DENY_SQL_TABLE_NOT_ALLOWED"
  | "DENY_SQL_INPUT_INVALID"
  | "DENY_SQL_NON_SELECT";

export type PolicyDecisionValue = "allow" | "deny";

export interface PolicyDecision {
  decision: PolicyDecisionValue;
  reason_code: PolicyReasonCode;
  reason: string;
}

export interface AuditLogRecord {
  timestamp: string;
  actor: string;
  bot_role: string;
  tool_name: string;
  resource: string;
  decision: "allow" | "deny";
  reason: string;
}

export interface GatewayToolRequestBody {
  resource: StructuredResource;
  input: unknown;
}
