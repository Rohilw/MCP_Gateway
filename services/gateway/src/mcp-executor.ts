import { evaluatePolicy, type GatewayToolRequestBody, type PolicyContext } from "@mcp-gateway/shared";
import type { AuditRepository } from "./audit-repository";
import { forwardMcpCall, type McpForwardSecurityOptions } from "./mcp-client";
import { redactSensitiveFields } from "./redaction";
import type { ServerRegistry } from "./server-registry";

export interface ExecutorActorContext {
  user_id: string;
  bot_role: string;
}

export interface ExecuteMcpToolInput {
  actor: ExecutorActorContext;
  serverName: string;
  toolName: string;
  body: GatewayToolRequestBody;
}

export type ExecuteMcpToolResult =
  | {
      ok: true;
      policyReasonCode: string;
      policyMessage: string;
      result: unknown;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      humanMessage: string;
      reasonCode?: string;
      details?: string;
    };

interface McpExecutorOptions {
  registry: ServerRegistry;
  auditRepository: AuditRepository;
  forwardSecurity: McpForwardSecurityOptions;
}

export interface McpExecutor {
  executeTool: (input: ExecuteMcpToolInput) => Promise<ExecuteMcpToolResult>;
}

async function writeAuditLog(
  auditRepository: AuditRepository,
  params: {
    actor: string;
    bot_role: string;
    tool_name: string;
    resource: GatewayToolRequestBody["resource"];
    decision: "allow" | "deny";
    reason_code: string;
    human_message: string;
  }
): Promise<void> {
  await auditRepository.logDecision({
    timestamp: new Date().toISOString(),
    actor: params.actor,
    bot_role: params.bot_role,
    tool_name: params.tool_name,
    resource: JSON.stringify(params.resource),
    decision: params.decision,
    reason: `${params.reason_code}: ${params.human_message}`
  });
}

export function createMcpExecutor(options: McpExecutorOptions): McpExecutor {
  const { registry, auditRepository, forwardSecurity } = options;

  async function executeTool(input: ExecuteMcpToolInput): Promise<ExecuteMcpToolResult> {
    const { actor, serverName, toolName, body } = input;
    const { resource, input: toolInput } = body;
    const registeredServer = registry[serverName];

    if (!registeredServer) {
      const reasonCode = "DENY_SERVER_NOT_REGISTERED";
      const humanMessage = `No MCP server registered for '${serverName}'`;
      await writeAuditLog(auditRepository, {
        actor: actor.user_id,
        bot_role: actor.bot_role,
        tool_name: toolName,
        resource,
        decision: "deny",
        reason_code: reasonCode,
        human_message: humanMessage
      });
      return {
        ok: false,
        statusCode: 403,
        error: "forbidden",
        reasonCode,
        humanMessage
      };
    }

    if (!registeredServer.tools.includes(toolName)) {
      const reasonCode = "DENY_TOOL_NOT_REGISTERED";
      const humanMessage = `Tool '${toolName}' is not registered for server '${serverName}'`;
      await writeAuditLog(auditRepository, {
        actor: actor.user_id,
        bot_role: actor.bot_role,
        tool_name: toolName,
        resource,
        decision: "deny",
        reason_code: reasonCode,
        human_message: humanMessage
      });
      return {
        ok: false,
        statusCode: 403,
        error: "forbidden",
        reasonCode,
        humanMessage
      };
    }

    if (resource.source !== serverName) {
      const reasonCode = "DENY_TOOL_RESOURCE_MISMATCH";
      const humanMessage = "Resource source does not match requested server";
      await writeAuditLog(auditRepository, {
        actor: actor.user_id,
        bot_role: actor.bot_role,
        tool_name: toolName,
        resource,
        decision: "deny",
        reason_code: reasonCode,
        human_message: humanMessage
      });
      return {
        ok: false,
        statusCode: 403,
        error: "forbidden",
        reasonCode,
        humanMessage
      };
    }

    const policyContext: PolicyContext = {
      actor: {
        user_id: actor.user_id,
        bot_role: actor.bot_role
      },
      tool: {
        name: toolName
      },
      resource,
      input: toolInput
    };
    const decision = evaluatePolicy(policyContext);

    await writeAuditLog(auditRepository, {
      actor: actor.user_id,
      bot_role: actor.bot_role,
      tool_name: toolName,
      resource,
      decision: decision.decision,
      reason_code: decision.reason_code,
      human_message: decision.reason
    });

    if (decision.decision === "deny") {
      return {
        ok: false,
        statusCode: 403,
        error: "forbidden",
        reasonCode: decision.reason_code,
        humanMessage: decision.reason
      };
    }

    try {
      const result = await forwardMcpCall(registeredServer.base_url, {
        tool_name: toolName,
        resource,
        input: toolInput,
        actor: actor.user_id,
        bot_role: actor.bot_role
      }, forwardSecurity);

      const redactedResult = redactSensitiveFields(result);
      return {
        ok: true,
        policyReasonCode: decision.reason_code,
        policyMessage: decision.reason,
        result: redactedResult
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return {
        ok: false,
        statusCode: 502,
        error: "upstream_error",
        humanMessage: "Failed to forward MCP call",
        details: message
      };
    }
  }

  return {
    executeTool
  };
}
