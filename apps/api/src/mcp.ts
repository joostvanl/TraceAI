import type { Hono } from "hono";
import { isTraceaiToken, type AuthStore } from "@traceai/auth";
import { TraceApiClient } from "@traceai/core";
import { handleTraceAiMcpHttpRequest } from "@traceai/mcp";
import type { AppVariables } from "./middleware.js";

export const DEFAULT_TRACEAI_PUBLIC_API_URL =
  "https://traceai.joostvanleeuwaarden.com";

export function resolvePublicApiUrl(): string {
  const raw =
    process.env.TRACEAI_PUBLIC_API_URL?.trim() || DEFAULT_TRACEAI_PUBLIC_API_URL;
  const apiUrl = raw.replace(/\/+$/, "");
  if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(apiUrl)) {
    throw new Error(
      `TRACEAI_PUBLIC_API_URL must not be loopback (${apiUrl}). Use ${DEFAULT_TRACEAI_PUBLIC_API_URL}.`,
    );
  }
  return apiUrl;
}

function unauthorized(message: string, code: string) {
  return Response.json({ message, code }, { status: 401 });
}

/**
 * Mount Streamable HTTP MCP at `/mcp`.
 * Tool calls use TraceApiClient with an in-process fetch into the same Hono app
 * (Bearer token from the MCP request), so there is no HTTP loopback to localhost.
 */
export function mountTraceAiMcp(
  app: Hono<{ Variables: AppVariables }>,
  authStore: AuthStore,
) {
  const publicApiUrl = resolvePublicApiUrl();

  const handler = async (c: {
    req: { raw: Request; header: (name: string) => string | undefined };
  }) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return unauthorized("Missing Bearer token", "UNAUTHORIZED");
    }
    const raw = match[1].trim();
    if (!isTraceaiToken(raw)) {
      return unauthorized("Expected a TraceAI token (trc_…)", "INVALID_TOKEN");
    }
    const auth = authStore.authenticate(raw);
    if (!auth) {
      return unauthorized(
        "Invalid, revoked, or expired TraceAI token",
        "UNAUTHORIZED",
      );
    }

    const client = new TraceApiClient({
      apiUrl: publicApiUrl,
      token: raw,
      fetchImpl: async (input, init) => {
        const href =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const parsed = new URL(href, publicApiUrl);
        return app.request(parsed.pathname + parsed.search, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body ?? undefined,
        });
      },
    });

    return handleTraceAiMcpHttpRequest(c.req.raw, client, { stateless: true });
  };

  app.all("/mcp", async (c) => handler(c));
}
