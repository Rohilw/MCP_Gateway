import { createHmac, timingSafeEqual } from "node:crypto";

export const MCP_SIGNATURE_VERSION = "v1";

export type McpSignatureReasonCode =
  | "DENY_MCP_SIGNATURE_MISSING"
  | "DENY_MCP_SIGNATURE_INVALID"
  | "DENY_MCP_SIGNATURE_STALE"
  | "DENY_MCP_SIGNATURE_REPLAY";

export type SignatureValidationResult =
  | {
      ok: true;
      nonce: string;
      timestampMs: number;
    }
  | {
      ok: false;
      reason_code: McpSignatureReasonCode;
      reason: string;
    };

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      const transformed = normalizeForCanonicalJson(record[key]);
      if (transformed !== undefined) {
        normalized[key] = transformed;
      }
    }
    return normalized;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }

  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  const normalized = normalizeForCanonicalJson(value);
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined) {
    return "null";
  }
  return serialized;
}

function buildSigningMessage(timestamp: string, nonce: string, canonicalBody: string): string {
  return `${timestamp}.${nonce}.${canonicalBody}`;
}

export function createMcpRequestSignature(params: {
  secret: string;
  timestamp: string;
  nonce: string;
  payload: unknown;
}): string {
  const canonicalBody = canonicalJsonStringify(params.payload);
  const message = buildSigningMessage(params.timestamp, params.nonce, canonicalBody);
  return createHmac("sha256", params.secret).update(message).digest("hex");
}

function parseSignatureHeader(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function safeCompareHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMcpRequestSignature(params: {
  secret: string;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  payload: unknown;
  maxSkewMs: number;
  nowMs?: number;
}): SignatureValidationResult {
  if (!params.signature || !params.timestamp || !params.nonce) {
    return {
      ok: false,
      reason_code: "DENY_MCP_SIGNATURE_MISSING",
      reason: "Missing signed gateway request headers"
    };
  }

  const timestampMs = Number(params.timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return {
      ok: false,
      reason_code: "DENY_MCP_SIGNATURE_INVALID",
      reason: "Invalid signature timestamp header"
    };
  }

  const nowMs = params.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > params.maxSkewMs) {
    return {
      ok: false,
      reason_code: "DENY_MCP_SIGNATURE_STALE",
      reason: "Signed request timestamp is outside the accepted clock skew window"
    };
  }

  const parsedSignature = parseSignatureHeader(params.signature);
  if (!parsedSignature) {
    return {
      ok: false,
      reason_code: "DENY_MCP_SIGNATURE_INVALID",
      reason: "Invalid signature format"
    };
  }

  const expectedSignature = createMcpRequestSignature({
    secret: params.secret,
    timestamp: params.timestamp,
    nonce: params.nonce,
    payload: params.payload
  });

  if (!safeCompareHex(parsedSignature, expectedSignature.toLowerCase())) {
    return {
      ok: false,
      reason_code: "DENY_MCP_SIGNATURE_INVALID",
      reason: "Gateway request signature validation failed"
    };
  }

  return {
    ok: true,
    nonce: params.nonce,
    timestampMs
  };
}

export class NonceReplayGuard {
  private readonly seenNonces = new Map<string, number>();

  public constructor(private readonly ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("NonceReplayGuard ttlMs must be a positive number");
    }
  }

  public isReplay(nonce: string, nowMs = Date.now()): boolean {
    this.pruneExpired(nowMs);
    const existingExpiry = this.seenNonces.get(nonce);
    if (existingExpiry && existingExpiry > nowMs) {
      return true;
    }
    this.seenNonces.set(nonce, nowMs + this.ttlMs);
    return false;
  }

  private pruneExpired(nowMs: number): void {
    for (const [nonce, expiresAt] of this.seenNonces.entries()) {
      if (expiresAt <= nowMs) {
        this.seenNonces.delete(nonce);
      }
    }
  }
}
