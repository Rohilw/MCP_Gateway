import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, isReadOnlySqlQuery } from "./policy";
import type { PolicyContext, StructuredResource } from "./types";

function wikiResource(): StructuredResource {
  return {
    source: "wiki",
    space: "knowledge",
    page: "benefits-overview"
  };
}

function sqlResource(table: string): StructuredResource {
  return {
    source: "sql",
    db: "people_ops",
    schema: "hr",
    table
  };
}

function buildContext(params: {
  user_id: string;
  bot_role: string;
  tool_name: string;
  resource: StructuredResource;
  input: unknown;
}): PolicyContext {
  return {
    actor: {
      user_id: params.user_id,
      bot_role: params.bot_role
    },
    tool: {
      name: params.tool_name
    },
    resource: params.resource,
    input: params.input
  };
}

test("MARKETING_BOT can access wiki tools", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-1",
      bot_role: "MARKETING_BOT",
      tool_name: "wiki.search",
      resource: wikiResource(),
      input: { query: "campaign" }
    })
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason_code, "ALLOW_MARKETING_WIKI");
});

test("MARKETING_BOT is denied SQL access", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-2",
      bot_role: "MARKETING_BOT",
      tool_name: "sql.query",
      resource: sqlResource("employees"),
      input: { query: "select * from employees" }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_SOURCE_NOT_ALLOWED");
});

test("HR_BOT can access wiki tools", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-3",
      bot_role: "HR_BOT",
      tool_name: "wiki.search",
      resource: wikiResource(),
      input: { query: "handbook" }
    })
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason_code, "ALLOW_HR_WIKI");
});

test("HR_BOT can run read-only SQL on allowed table", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-4",
      bot_role: "HR_BOT",
      tool_name: "sql.query",
      resource: sqlResource("employees"),
      input: { query: "SELECT id, name FROM employees LIMIT 10" }
    })
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason_code, "ALLOW_HR_SQL_SELECT");
});

test("HR_BOT can access SQL metadata tools", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-4b",
      bot_role: "HR_BOT",
      tool_name: "sql.listTables",
      resource: sqlResource("employees"),
      input: { db: "mcp_gateway", schema: "public" }
    })
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason_code, "ALLOW_HR_SQL_METADATA");
});

test("HR_BOT cannot access disallowed SQL table", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-5",
      bot_role: "HR_BOT",
      tool_name: "sql.query",
      resource: sqlResource("payroll_line_items"),
      input: { query: "SELECT * FROM payroll_line_items" }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_SQL_TABLE_NOT_ALLOWED");
});

test("HR_BOT cannot execute non-SELECT SQL", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-6",
      bot_role: "HR_BOT",
      tool_name: "sql.query",
      resource: sqlResource("payroll_summary"),
      input: { query: "UPDATE payroll_summary SET total=0" }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_SQL_NON_SELECT");
});

test("SQL tool with wiki resource is denied for mismatch", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-7",
      bot_role: "HR_BOT",
      tool_name: "sql.query",
      resource: wikiResource(),
      input: { query: "SELECT 1" }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_TOOL_RESOURCE_MISMATCH");
});

test("unknown bot role is denied", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-8",
      bot_role: "FINANCE_BOT",
      tool_name: "wiki.search",
      resource: wikiResource(),
      input: { query: "budget" }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_ROLE_NOT_ALLOWED");
});

test("SQL input is required for sql.query", () => {
  const decision = evaluatePolicy(
    buildContext({
      user_id: "u-9",
      bot_role: "HR_BOT",
      tool_name: "sql.query",
      resource: sqlResource("employees"),
      input: { not_query: true }
    })
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "DENY_SQL_INPUT_INVALID");
});

test("read-only SQL detector allows SELECT/CTE and blocks writes", () => {
  assert.equal(isReadOnlySqlQuery("SELECT * FROM employees"), true);
  assert.equal(isReadOnlySqlQuery("WITH t AS (SELECT * FROM employees) SELECT * FROM t"), true);
  assert.equal(isReadOnlySqlQuery("SELECT * FROM employees; DELETE FROM employees"), false);
  assert.equal(isReadOnlySqlQuery("INSERT INTO employees(id) VALUES (1)"), false);
});
