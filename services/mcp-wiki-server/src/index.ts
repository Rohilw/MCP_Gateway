import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import {
  MCP_SIGNATURE_VERSION,
  NonceReplayGuard,
  verifyMcpRequestSignature
} from "@mcp-gateway/shared";

interface McpWikiCallBody {
  tool_name: string;
  resource: WikiResource;
  input: unknown;
  actor: string;
  bot_role: string;
}

interface WikiResource {
  source: "wiki";
  space: string;
  page: string;
}

interface WikiListPagesInput {
  limit?: number;
}

interface WikiGetPageInput {
  page_id: string;
}

interface WikiSearchInput {
  query: string;
  limit?: number;
}

interface WikiPage {
  page_id: string;
  title: string;
  markdown: string;
  snippet: string;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "show",
  "summarize",
  "tell",
  "the",
  "to",
  "what",
  "with"
]);

function isMcpWikiCallBody(value: unknown): value is McpWikiCallBody {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    tool_name?: unknown;
    resource?: unknown;
    input?: unknown;
    actor?: unknown;
    bot_role?: unknown;
  };
  return (
    typeof candidate.tool_name === "string" &&
    isWikiResource(candidate.resource) &&
    typeof candidate.actor === "string" &&
    typeof candidate.bot_role === "string" &&
    Object.prototype.hasOwnProperty.call(candidate, "input")
  );
}

function isWikiResource(value: unknown): value is WikiResource {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as WikiResource;
  return (
    candidate.source === "wiki" &&
    typeof candidate.space === "string" &&
    typeof candidate.page === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseListPagesInput(value: unknown): WikiListPagesInput | null {
  if (value === null || value === undefined) {
    return {};
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const rawLimit = record["limit"];
  if (rawLimit === undefined) {
    return {};
  }
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit <= 0) {
    return null;
  }
  return { limit: rawLimit };
}

function parseGetPageInput(value: unknown): WikiGetPageInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pageId = record["page_id"];
  if (typeof pageId !== "string" || pageId.trim().length === 0) {
    return null;
  }
  return { page_id: pageId.trim() };
}

function parseSearchInput(value: unknown): WikiSearchInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const query = record["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return null;
  }

  const rawLimit = record["limit"];
  if (rawLimit === undefined) {
    return { query: query.trim() };
  }
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit <= 0) {
    return null;
  }

  return { query: query.trim(), limit: rawLimit };
}

function toSnippet(markdown: string, maxLength = 220): string {
  const plainText = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/[_*~>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plainText.length <= maxLength) {
    return plainText;
  }
  return `${plainText.slice(0, maxLength - 3)}...`;
}

function extractTitle(markdown: string, fallback: string): string {
  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1]) {
    return headingMatch[1].trim();
  }
  return fallback;
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchQuery(query: string): string[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const filtered = tokens.filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
  return Array.from(new Set(filtered.length > 0 ? filtered : tokens));
}

function countOccurrences(corpus: string, term: string): number {
  if (!term) {
    return 0;
  }
  return corpus.split(term).length - 1;
}

function scoreWikiSearchMatch(corpus: string, rawQuery: string, queryTokens: string[]): number {
  const normalizedCorpus = normalizeSearchText(corpus);
  const normalizedQuery = normalizeSearchText(rawQuery);

  let score = 0;
  if (normalizedQuery.length > 0) {
    const exactMatches = countOccurrences(normalizedCorpus, normalizedQuery);
    score += exactMatches * 4;
  }

  for (const token of queryTokens) {
    score += countOccurrences(normalizedCorpus, token);
  }

  return score;
}

async function resolveWikiDirectory(configuredPath: string | undefined): Promise<string> {
  if (configuredPath) {
    return path.resolve(process.cwd(), configuredPath);
  }

  const candidates = [
    path.resolve(process.cwd(), "services/mcp-wiki-server/data/wiki"),
    path.resolve(process.cwd(), "data/wiki"),
    path.resolve(__dirname, "..", "data", "wiki")
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  return candidates[0] ?? path.resolve(process.cwd(), "services/mcp-wiki-server/data/wiki");
}

async function loadWikiPages(wikiDirectory: string): Promise<WikiPage[]> {
  const entries = await fs.readdir(wikiDirectory, {
    withFileTypes: true
  });

  const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
  const pages = await Promise.all(
    markdownFiles.map(async (entry) => {
      const pageId = entry.name.replace(/\.md$/i, "");
      const fullPath = path.join(wikiDirectory, entry.name);
      const markdown = await fs.readFile(fullPath, "utf8");
      return {
        page_id: pageId,
        title: extractTitle(markdown, pageId),
        markdown,
        snippet: toSnippet(markdown)
      };
    })
  );

  pages.sort((a, b) => a.page_id.localeCompare(b.page_id));
  return pages;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
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

function parsePositiveInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return parsed;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function buildHttpsOptions(): {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  requestCert: boolean;
  rejectUnauthorized: boolean;
} {
  const certFile = process.env["TLS_CERT_FILE"];
  const keyFile = process.env["TLS_KEY_FILE"];
  const caFile = process.env["TLS_CA_FILE"];
  const requireClientCert = parseBoolean(process.env["TLS_REQUIRE_CLIENT_CERT"], true);

  if (!certFile || !keyFile) {
    throw new Error("TLS_ENABLED=true requires TLS_CERT_FILE and TLS_KEY_FILE");
  }
  if (requireClientCert && !caFile) {
    throw new Error("TLS_REQUIRE_CLIENT_CERT=true requires TLS_CA_FILE");
  }

  return {
    cert: syncFs.readFileSync(certFile),
    key: syncFs.readFileSync(keyFile),
    ...(caFile ? { ca: syncFs.readFileSync(caFile) } : {}),
    requestCert: requireClientCert,
    rejectUnauthorized: requireClientCert
  };
}

async function start(): Promise<void> {
  const tlsEnabled = parseBoolean(process.env["TLS_ENABLED"], false);
  const serverOptions = (
    tlsEnabled
      ? {
          logger: true,
          https: buildHttpsOptions()
        }
      : {
          logger: true
        }
  ) as Parameters<typeof Fastify>[0];
  const server = Fastify(serverOptions);
  const port = Number(process.env["PORT"] ?? "4200");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid PORT value");
  }
  const mcpHmacSecret = process.env["MCP_HMAC_SECRET"] ?? "dev-only-change-me-hmac";
  const signatureToleranceMs = parsePositiveInteger(
    process.env["MCP_SIGNATURE_TOLERANCE_MS"],
    300_000,
    "MCP_SIGNATURE_TOLERANCE_MS"
  );
  const nonceReplayGuard = new NonceReplayGuard(signatureToleranceMs);
  const wikiDirectory = await resolveWikiDirectory(process.env["WIKI_DATA_DIR"]);

  server.get("/health", async () => ({ status: "ok" }));

  server.post<{ Body: unknown }>("/mcp/call", async (request, reply) => {
    const signatureVersion = firstHeaderValue(request.headers["x-mcp-signature-version"]);
    if (signatureVersion !== MCP_SIGNATURE_VERSION) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: "DENY_MCP_SIGNATURE_INVALID",
        human_message: "Unsupported MCP signature version"
      });
    }

    const signatureCheck = verifyMcpRequestSignature({
      secret: mcpHmacSecret,
      timestamp: firstHeaderValue(request.headers["x-mcp-timestamp"]),
      nonce: firstHeaderValue(request.headers["x-mcp-nonce"]),
      signature: firstHeaderValue(request.headers["x-mcp-signature"]),
      payload: request.body,
      maxSkewMs: signatureToleranceMs
    });
    if (!signatureCheck.ok) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: signatureCheck.reason_code,
        human_message: signatureCheck.reason
      });
    }
    if (nonceReplayGuard.isReplay(signatureCheck.nonce)) {
      return reply.status(401).send({
        error: "unauthorized",
        reason_code: "DENY_MCP_SIGNATURE_REPLAY",
        human_message: "Signed request nonce has already been used"
      });
    }

    if (!isMcpWikiCallBody(request.body)) {
      return reply.status(400).send({
        error: "bad_request",
        human_message: "Invalid body. Expected wiki resource {source,space,page}"
      });
    }

    const { tool_name: toolName, resource, input, actor, bot_role: botRole } = request.body;
    const pages = await loadWikiPages(wikiDirectory);

    if (toolName === "wiki.listPages") {
      const parsed = parseListPagesInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "wiki.listPages expects optional input: { limit?: number }"
        });
      }

      const limit = parsed.limit ?? 50;
      const selected = pages.slice(0, limit).map((page) => ({
        page_id: page.page_id,
        title: page.title,
        snippet: page.snippet
      }));

      return reply.send({
        server: "mcp-wiki-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: {
          pages: selected,
          total: pages.length
        }
      });
    }

    if (toolName === "wiki.getPage") {
      const parsed = parseGetPageInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "wiki.getPage expects input: { page_id: string }"
        });
      }

      const page = pages.find((candidate) => candidate.page_id === parsed.page_id);
      if (!page) {
        return reply.status(404).send({
          error: "not_found",
          human_message: `Page not found: ${parsed.page_id}`
        });
      }

      return reply.send({
        server: "mcp-wiki-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: {
          page_id: page.page_id,
          title: page.title,
          snippet: page.snippet,
          markdown: page.markdown
        }
      });
    }

    if (toolName === "wiki.search") {
      const parsed = parseSearchInput(input);
      if (!parsed) {
        return reply.status(400).send({
          error: "bad_request",
          human_message: "wiki.search expects input: { query: string, limit?: number }"
        });
      }

      const queryTokens = tokenizeSearchQuery(parsed.query);
      const limit = parsed.limit ?? 20;
      const hits = pages
        .map((page) => {
          const corpus = `${page.page_id}\n${page.title}\n${page.markdown}`.toLowerCase();
          const matches = scoreWikiSearchMatch(corpus, parsed.query, queryTokens);
          return {
            page_id: page.page_id,
            title: page.title,
            snippet: page.snippet,
            matches
          };
        })
        .filter((page) => page.matches > 0)
        .sort((a, b) => b.matches - a.matches || a.page_id.localeCompare(b.page_id))
        .slice(0, limit);

      return reply.send({
        server: "mcp-wiki-server",
        tool_name: toolName,
        actor,
        bot_role: botRole,
        resource,
        output: {
          query: parsed.query,
          hits
        }
      });
    }

    return reply.status(400).send({
      error: "bad_request",
      human_message: `Unsupported wiki MCP tool: ${toolName}`
    });
  });

  await server.listen({
    host: "0.0.0.0",
    port
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
