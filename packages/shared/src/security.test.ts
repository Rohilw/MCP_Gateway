import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NonceReplayGuard,
  canonicalJsonStringify,
  createMcpRequestSignature,
  verifyMcpRequestSignature
} from "./security";

test("canonicalJsonStringify orders object keys deterministically", () => {
  const first = canonicalJsonStringify({
    z: 1,
    nested: {
      b: 2,
      a: 1
    }
  });
  const second = canonicalJsonStringify({
    nested: {
      a: 1,
      b: 2
    },
    z: 1
  });

  assert.equal(first, second);
});

test("verifyMcpRequestSignature validates a correctly signed payload", () => {
  const payload = {
    tool_name: "wiki.search",
    input: {
      query: "benefits"
    }
  };
  const timestamp = `${Date.now()}`;
  const nonce = "nonce-1";
  const secret = "test-secret";
  const signature = createMcpRequestSignature({
    secret,
    timestamp,
    nonce,
    payload
  });

  const result = verifyMcpRequestSignature({
    secret,
    timestamp,
    nonce,
    signature,
    payload,
    maxSkewMs: 60_000
  });

  assert.equal(result.ok, true);
});

test("verifyMcpRequestSignature denies stale requests", () => {
  const nowMs = 1_000_000;
  const payload = {
    hello: "world"
  };
  const timestamp = `${nowMs - 120_000}`;
  const nonce = "nonce-2";
  const secret = "test-secret";
  const signature = createMcpRequestSignature({
    secret,
    timestamp,
    nonce,
    payload
  });

  const result = verifyMcpRequestSignature({
    secret,
    timestamp,
    nonce,
    signature,
    payload,
    maxSkewMs: 30_000,
    nowMs
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason_code, "DENY_MCP_SIGNATURE_STALE");
  }
});

test("NonceReplayGuard flags reused nonce", () => {
  const guard = new NonceReplayGuard(1_000);
  const nonce = "nonce-3";

  assert.equal(guard.isReplay(nonce, 0), false);
  assert.equal(guard.isReplay(nonce, 100), true);
  assert.equal(guard.isReplay(nonce, 1_500), false);
});
