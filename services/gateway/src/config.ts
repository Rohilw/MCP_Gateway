import path from "node:path";
import fs from "node:fs";

export interface MtlsClientConfig {
  enabled: boolean;
  certFile: string | undefined;
  keyFile: string | undefined;
  caFile: string | undefined;
  rejectUnauthorized: boolean;
}

export interface TokenRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface GatewayConfig {
  port: number;
  jwtSecret: string;
  postgresUrl: string;
  serverRegistryFile: string;
  mcpHmacSecret: string;
  mcpSignatureToleranceMs: number;
  mtlsClient: MtlsClientConfig;
  tokenRateLimit: TokenRateLimitConfig;
}

export function loadConfig(): GatewayConfig {
  const port = Number(process.env["PORT"] ?? "4000");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid PORT");
  }

  const jwtSecret = process.env["JWT_SECRET"] ?? "dev-only-change-me";
  const postgresUrl =
    process.env["POSTGRES_URL"] ?? "postgres://mcp_user:mcp_password@localhost:5432/mcp_gateway";
  const serverRegistryFile = resolveServerRegistryFile(process.env["SERVER_REGISTRY_FILE"]);
  const mcpHmacSecret = process.env["MCP_HMAC_SECRET"] ?? "dev-only-change-me-hmac";
  const mcpSignatureToleranceMs = parsePositiveInteger(
    process.env["MCP_SIGNATURE_TOLERANCE_MS"],
    300_000,
    "MCP_SIGNATURE_TOLERANCE_MS"
  );

  const mtlsEnabled = parseBoolean(process.env["MCP_MTLS_ENABLED"], false);
  const mtlsClient: MtlsClientConfig = {
    enabled: mtlsEnabled,
    certFile: resolveOptionalPath(process.env["MCP_MTLS_CERT_FILE"]),
    keyFile: resolveOptionalPath(process.env["MCP_MTLS_KEY_FILE"]),
    caFile: resolveOptionalPath(process.env["MCP_MTLS_CA_FILE"]),
    rejectUnauthorized: parseBoolean(process.env["MCP_MTLS_REJECT_UNAUTHORIZED"], true)
  };
  if (mtlsClient.enabled && (!mtlsClient.certFile || !mtlsClient.keyFile)) {
    throw new Error("MCP_MTLS_ENABLED=true requires MCP_MTLS_CERT_FILE and MCP_MTLS_KEY_FILE");
  }

  const tokenRateLimit: TokenRateLimitConfig = {
    windowMs: parsePositiveInteger(process.env["RATE_LIMIT_WINDOW_MS"], 60_000, "RATE_LIMIT_WINDOW_MS"),
    maxRequests: parsePositiveInteger(process.env["RATE_LIMIT_MAX_REQUESTS"], 60, "RATE_LIMIT_MAX_REQUESTS")
  };

  return {
    port,
    jwtSecret,
    postgresUrl,
    serverRegistryFile,
    mcpHmacSecret,
    mcpSignatureToleranceMs,
    mtlsClient,
    tokenRateLimit
  };
}

function resolveServerRegistryFile(configuredPath: string | undefined): string {
  if (configuredPath) {
    return path.resolve(process.cwd(), configuredPath);
  }

  const candidates = [
    path.resolve(process.cwd(), "services/gateway/config/server-registry.json"),
    path.resolve(process.cwd(), "config/server-registry.json"),
    path.resolve(__dirname, "..", "config", "server-registry.json")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const fallback = candidates[0];
  if (!fallback) {
    throw new Error("No server registry file candidates configured");
  }
  return fallback;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
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

function parsePositiveInteger(raw: string | undefined, defaultValue: number, envName: string): number {
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return parsed;
}

function resolveOptionalPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }
  return path.resolve(process.cwd(), rawPath);
}
