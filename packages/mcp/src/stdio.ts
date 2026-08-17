#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TraceApiClient } from "@traceai/core";
import { createTraceAiMcpServer } from "./register-tools.js";

function resolveApiUrl(): string {
  const raw = process.env.TRACEAI_API_URL?.trim();
  if (!raw) {
    throw new Error(
      "Set TRACEAI_API_URL in the TraceAI MCP env (e.g. https://traceai.joostvanleeuwaarden.com). Refusing to default to localhost — that silently breaks the live board when Cursor keeps a stale MCP process.",
    );
  }
  const apiUrl = raw.replace(/\/+$/, "");
  // Hard reject loopback: Cursor sometimes keeps orphan MCP processes that were
  // started with an old TRACEAI_API_URL. Fail loudly instead of writing to the
  // wrong instance.
  if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(apiUrl)) {
    throw new Error(
      `TRACEAI_API_URL must not be loopback (${apiUrl}). Point MCP at the public TraceAI API (https://traceai.joostvanleeuwaarden.com), run node scripts/cleanup-traceai-mcp.mjs, and reload the MCP server.`,
    );
  }
  return apiUrl;
}

function createClient(): TraceApiClient {
  const apiUrl = resolveApiUrl();
  const token = process.env.TRACEAI_TOKEN;
  if (!token) {
    throw new Error(
      "Set TRACEAI_TOKEN (trc_…) — TraceAI MCP no longer accepts Aurora credentials",
    );
  }
  if (!token.startsWith("trc_")) {
    throw new Error("TRACEAI_TOKEN must start with trc_");
  }
  return new TraceApiClient({ apiUrl, token });
}

async function main() {
  const client = createClient();
  const server = createTraceAiMcpServer(client);

  // stderr only — stdout is the MCP JSON-RPC transport.
  console.error(
    `[traceai-mcp] bound to ${resolveApiUrl()} (pid ${process.pid})`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
