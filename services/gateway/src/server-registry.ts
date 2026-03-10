import fs from "node:fs/promises";

export interface RegisteredServer {
  base_url: string;
  tools: string[];
}

export type ServerRegistry = Record<string, RegisteredServer>;

interface RegistryConfigFile {
  servers: ServerRegistry;
}

function resolveBaseUrl(raw: string): string {
  const envPattern = /^\$\{([A-Z0-9_]+)(?::([^}]+))?\}$/i;
  const match = envPattern.exec(raw);
  if (!match) {
    return raw;
  }

  const envName = match[1];
  const defaultValue = match[2];
  if (!envName) {
    throw new Error(`Invalid environment placeholder in registry base_url: ${raw}`);
  }
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  if (defaultValue) {
    return defaultValue;
  }

  throw new Error(`Missing required environment variable for server registry base_url: ${envName}`);
}

function validateServer(name: string, candidate: unknown): RegisteredServer {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Invalid server entry '${name}'`);
  }

  const parsed = candidate as {
    base_url?: unknown;
    tools?: unknown;
  };

  if (typeof parsed.base_url !== "string") {
    throw new Error(`Server '${name}' missing base_url`);
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.some((tool) => typeof tool !== "string")) {
    throw new Error(`Server '${name}' tools must be a string[]`);
  }

  return {
    base_url: resolveBaseUrl(parsed.base_url),
    tools: parsed.tools as string[]
  };
}

export async function loadServerRegistry(filePath: string): Promise<ServerRegistry> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as RegistryConfigFile;
  if (!parsed || typeof parsed !== "object" || !parsed.servers || typeof parsed.servers !== "object") {
    throw new Error(`Invalid server registry file: ${filePath}`);
  }

  const registry: ServerRegistry = {};
  for (const [name, server] of Object.entries(parsed.servers)) {
    registry[name] = validateServer(name, server);
  }

  return registry;
}
