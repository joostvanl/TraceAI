import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { TraceApiClient } from "@traceai/core";
import { createTraceAiMcpServer } from "./register-tools.js";

export type TraceAiMcpHttpOptions = {
  /**
   * When true (default), each request gets a fresh transport in JSON mode
   * (no MCP session sticky state). Safer for Bearer-token auth per request.
   */
  stateless?: boolean;
};

type McpSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  close: () => Promise<void>;
};

const sessions = new Map<string, McpSession>();

/**
 * Handle a Streamable HTTP MCP request for an already-authenticated client.
 * Auth (Bearer trc_…) must be enforced by the caller before invoking this.
 */
export async function handleTraceAiMcpHttpRequest(
  req: Request,
  client: TraceApiClient,
  options: TraceAiMcpHttpOptions = {},
): Promise<Response> {
  const stateless = options.stateless !== false;
  // Security is Bearer trc_… at the API edge. Do not enable SDK DNS-rebinding
  // Host checks — Cursor/proxies/app.request often omit or rewrite Host.

  if (stateless) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createTraceAiMcpServer(client);
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  const sessionId = req.headers.get("mcp-session-id")?.trim();
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing) {
      return Response.json(
        { message: "Unknown MCP session", code: "MCP_SESSION_NOT_FOUND" },
        { status: 404 },
      );
    }
    return existing.transport.handleRequest(req);
  }

  let transport!: WebStandardStreamableHTTPServerTransport;
  const server = createTraceAiMcpServer(client);
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, {
        transport,
        close: async () => {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        },
      });
    },
    onsessionclosed: (id) => {
      const session = sessions.get(id);
      sessions.delete(id);
      void session?.close();
    },
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
