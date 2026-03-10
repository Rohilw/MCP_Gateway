import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { Pool } from "pg";
import {
  signAccessToken,
  verifyAccessToken,
  type GatewayToolRequestBody,
  type StructuredResource
} from "@mcp-gateway/shared";
import { createAgentOrchestrator } from "./agent-orchestrator/orchestrator";
import { MockLlmProvider } from "./agent-orchestrator/mock-llm-provider";
import { AuditRepository } from "./audit-repository";
import { loadConfig } from "./config";
import { CredentialRepository } from "./credential-repository";
import { createMcpExecutor } from "./mcp-executor";
import { TokenRateLimiter } from "./rate-limiter";
import { redactSensitiveFields } from "./redaction";
import { loadServerRegistry } from "./server-registry";

declare module "fastify" {
  interface FastifyRequest {
    actorContext?: {
      user_id: string;
      bot_role: string;
    };
  }
}

interface LoginBody {
  username: string;
  password: string;
}

interface AgentChatBody {
  bot_role: string;
  message: string;
  user_id?: string;
}

function isLoginBody(value: unknown): value is LoginBody {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    username?: unknown;
    password?: unknown;
  };
  const username = typeof candidate.username === "string" ? candidate.username.trim() : "";
  const password = typeof candidate.password === "string" ? candidate.password : "";
  return username.length > 0 && password.length > 0;
}

function isAgentChatBody(value: unknown): value is AgentChatBody {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    bot_role?: unknown;
    message?: unknown;
    user_id?: unknown;
  };
  const botRole = typeof candidate.bot_role === "string" ? candidate.bot_role.trim() : "";
  const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
  return (
    botRole.length > 0 &&
    message.length > 0 &&
    (candidate.user_id === undefined || typeof candidate.user_id === "string")
  );
}

function isStructuredResource(value: unknown): value is StructuredResource {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    source?: unknown;
    db?: unknown;
    schema?: unknown;
    table?: unknown;
    space?: unknown;
    page?: unknown;
  };

  if (candidate.source === "sql") {
    return (
      typeof candidate.db === "string" &&
      typeof candidate.schema === "string" &&
      typeof candidate.table === "string"
    );
  }

  if (candidate.source === "wiki") {
    return typeof candidate.space === "string" && typeof candidate.page === "string";
  }

  return false;
}

function isGatewayToolRequestBody(value: unknown): value is GatewayToolRequestBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    resource?: unknown;
    input?: unknown;
  };

  return isStructuredResource(candidate.resource) && Object.prototype.hasOwnProperty.call(candidate, "input");
}

function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

async function authenticateMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
  rateLimiter: TokenRateLimiter
): Promise<unknown> {
  const token = readBearerToken(request.headers.authorization);
  if (!token) {
    return reply.status(401).send({
      error: "unauthorized",
      human_message: "Missing or invalid Authorization header"
    });
  }

  let claims: ReturnType<typeof verifyAccessToken>;
  try {
    claims = verifyAccessToken(token, jwtSecret);
  } catch (error) {
    request.log.warn({ error }, "Token verification failed");
    return reply.status(401).send({
      error: "unauthorized",
      human_message: "Invalid or expired token"
    });
  }

  request.actorContext = {
    user_id: claims.sub,
    bot_role: claims.bot_role
  };

  const rateLimit = rateLimiter.consume(token);
  if (!rateLimit.allowed) {
    const retryAfterSeconds = Math.max(Math.ceil(rateLimit.resetInMs / 1000), 1);
    reply.header("retry-after", `${retryAfterSeconds}`);
    return reply.status(429).send({
      error: "rate_limited",
      reason_code: "RATE_LIMIT_EXCEEDED",
      human_message: "Too many requests for this token. Try again later."
    });
  }

  return undefined;
}

async function start(): Promise<void> {
  const config = loadConfig();
  const registry = await loadServerRegistry(config.serverRegistryFile);

  const server = Fastify({
    logger: true
  });

  await server.register(cors, {
    origin: true
  });

  const pool = new Pool({
    connectionString: config.postgresUrl
  });
  const auditRepository = new AuditRepository(pool);
  await auditRepository.initialize();
  const credentialRepository = new CredentialRepository(pool);
  await credentialRepository.initialize();

  const executor = createMcpExecutor({
    registry,
    auditRepository,
    forwardSecurity: {
      hmacSecret: config.mcpHmacSecret,
      mtls: config.mtlsClient
    }
  });
  const tokenRateLimiter = new TokenRateLimiter({
    windowMs: config.tokenRateLimit.windowMs,
    maxRequests: config.tokenRateLimit.maxRequests
  });

  const orchestrator = createAgentOrchestrator({
    executor,
    llm: new MockLlmProvider()
  });

  server.addHook("onClose", async () => {
    await pool.end();
  });

  server.get("/health", async () => {
    return { status: "ok" };
  });

  server.post<{ Body: unknown }>("/auth/token", async (request, reply) => {
    if (!isLoginBody(request.body)) {
      return reply.status(400).send({
        error: "bad_request",
        human_message: "Invalid body. Expected: { username: string, password: string }"
      });
    }

    const identity = await credentialRepository.authenticate(request.body.username, request.body.password);
    if (!identity) {
      return reply.status(401).send({
        error: "unauthorized",
        human_message: "Invalid username or password"
      });
    }

    const accessToken = signAccessToken(
      {
        sub: identity.user_id,
        bot_role: identity.bot_role
      },
      config.jwtSecret,
      { expiresIn: "5m" }
    );

    return reply.send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in_seconds: 300,
      user_id: identity.user_id,
      bot_role: identity.bot_role
    });
  });

  server.post<{
    Params: { server: string; toolName: string };
    Body: unknown;
  }>(
    "/mcp/:server/tools/:toolName",
    {
      preHandler: async (request, reply) =>
        authenticateMcpRequest(request, reply, config.jwtSecret, tokenRateLimiter)
    },
    async (request, reply) => {
      const actor = request.actorContext;
      if (!actor) {
        return reply.status(500).send({
          error: "internal_error",
          human_message: "Missing actor context after authentication"
        });
      }

      if (!isGatewayToolRequestBody(request.body)) {
        return reply.status(400).send({
          error: "bad_request",
          human_message:
            "Invalid body. Expected: { resource: sql{source,db,schema,table} | wiki{source,space,page}, input: unknown }"
        });
      }

      const serverName = request.params.server;
      const toolName = request.params.toolName;
      const execution = await executor.executeTool({
        actor,
        serverName,
        toolName,
        body: request.body
      });

      if (!execution.ok) {
        const errorPayload = redactSensitiveFields({
          error: execution.error,
          reason_code: execution.reasonCode ?? null,
          human_message: execution.humanMessage,
          details: execution.details ?? null
        });
        return reply.status(execution.statusCode).send(errorPayload);
      }

      const successPayload = redactSensitiveFields({
        decision: "allow",
        reason_code: execution.policyReasonCode,
        human_message: execution.policyMessage,
        result: execution.result
      });
      return reply.send(successPayload);
    }
  );

  server.post<{ Body: unknown }>(
    "/agent/chat",
    {
      preHandler: async (request, reply) =>
        authenticateMcpRequest(request, reply, config.jwtSecret, tokenRateLimiter)
    },
    async (request, reply) => {
      if (!isAgentChatBody(request.body)) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "Invalid body. Expected: { bot_role: string, message: string }"
        });
      }

      const actor = request.actorContext;
      if (!actor) {
        return reply.status(500).send({
          error: "internal_error",
          human_message: "Missing actor context after authentication"
        });
      }

      const requestedBotRole = request.body.bot_role.trim();
      if (requestedBotRole !== actor.bot_role) {
        return reply.status(403).send({
          error: "forbidden",
          reason_code: "DENY_ACTOR_BOT_ROLE_MISMATCH",
          human_message: "bot_role in request body must match bot_role in JWT token"
        });
      }

      const message = request.body.message.trim();

      const result = await orchestrator.run({
        bot_role: actor.bot_role,
        message,
        user_id: actor.user_id
      });

      const payload = redactSensitiveFields({
        bot_role: actor.bot_role,
        message,
        answer: result.answer,
        tool_calls: result.tool_calls.map((toolCall) => ({
          citation_id: toolCall.citation_id,
          server_name: toolCall.server_name,
          tool_name: toolCall.tool_name,
          request: toolCall.request,
          response: toolCall.response
        })),
        prompts_used: result.prompts_used
      });

      return reply.send(payload);
    }
  );

  server.get<{ Querystring: { limit?: string } }>("/audit", async (request, reply) => {
    const rawLimit = request.query.limit ?? "20";
    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > 200) {
      return reply.status(400).send({
        error: "bad_request",
        human_message: "limit must be an integer between 1 and 200"
      });
    }

    const rows = await auditRepository.listRecent(parsedLimit);
    const payload = redactSensitiveFields({
      items: rows
    });
    return reply.send(payload);
  });

  await server.listen({
    port: config.port,
    host: "0.0.0.0"
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
