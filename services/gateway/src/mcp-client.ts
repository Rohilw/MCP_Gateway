import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import {
  MCP_SIGNATURE_VERSION,
  canonicalJsonStringify,
  createMcpRequestSignature,
  type StructuredResource
} from "@mcp-gateway/shared";
import type { MtlsClientConfig } from "./config";

export interface McpForwardPayload {
  tool_name: string;
  resource: StructuredResource;
  input: unknown;
  actor: string;
  bot_role: string;
}

export interface McpForwardSecurityOptions {
  hmacSecret: string;
  mtls: MtlsClientConfig;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function toCallUrl(targetBaseUrl: string): URL {
  return new URL("mcp/call", ensureTrailingSlash(targetBaseUrl));
}

function loadTlsMaterials(mtls: MtlsClientConfig): { cert: Buffer; key: Buffer; ca?: Buffer } {
  if (!mtls.certFile || !mtls.keyFile) {
    throw new Error("mTLS is enabled but cert/key files are not configured");
  }

  const cert = fs.readFileSync(mtls.certFile);
  const key = fs.readFileSync(mtls.keyFile);
  const ca = mtls.caFile ? fs.readFileSync(mtls.caFile) : undefined;

  return ca
    ? {
        cert,
        key,
        ca
      }
    : {
        cert,
        key
      };
}

async function postJson(
  url: URL,
  payload: string,
  headers: Record<string, string>,
  mtls: MtlsClientConfig
): Promise<{
  statusCode: number;
  body: string;
}> {
  const isHttps = url.protocol === "https:";
  if (!isHttps && mtls.enabled) {
    throw new Error("mTLS is enabled but MCP server URL is not https://");
  }

  const requestHeaders: Record<string, string> = {
    ...headers,
    "content-length": Buffer.byteLength(payload).toString()
  };

  const requestOptions: http.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: requestHeaders
  };

  let clientTls: ReturnType<typeof loadTlsMaterials> | undefined;
  if (isHttps && mtls.enabled) {
    clientTls = loadTlsMaterials(mtls);
  }

  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: response.statusCode ?? 0,
          body
        });
      });
    };

    const request = isHttps
      ? https.request(
          {
            ...requestOptions,
            ...(clientTls
              ? {
                  cert: clientTls.cert,
                  key: clientTls.key,
                  ...(clientTls.ca ? { ca: clientTls.ca } : {})
                }
              : {}),
            rejectUnauthorized: mtls.rejectUnauthorized
          },
          onResponse
        )
      : http.request(requestOptions, onResponse);

    request.setTimeout(10_000, () => {
      request.destroy(new Error("MCP upstream request timed out"));
    });

    request.on("error", (error) => {
      reject(error);
    });

    request.write(payload);
    request.end();
  });
}

export async function forwardMcpCall(
  targetBaseUrl: string,
  payload: McpForwardPayload,
  security: McpForwardSecurityOptions
): Promise<unknown> {
  const timestamp = `${Date.now()}`;
  const nonce = randomUUID();
  const serializedPayload = canonicalJsonStringify(payload);
  const signature = createMcpRequestSignature({
    secret: security.hmacSecret,
    timestamp,
    nonce,
    payload
  });

  const response = await postJson(
    toCallUrl(targetBaseUrl),
    serializedPayload,
    {
      "content-type": "application/json",
      "x-mcp-signature-version": MCP_SIGNATURE_VERSION,
      "x-mcp-signature": signature,
      "x-mcp-timestamp": timestamp,
      "x-mcp-nonce": nonce
    },
    security.mtls
  );

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Upstream MCP server error (${response.statusCode}): ${response.body}`);
  }

  try {
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Upstream MCP server returned invalid JSON: ${message}`);
  }
}
