import { TraceApiClient } from "@traceai/core";

/** Server-side TraceAI API client (create + human-gated transitions). */
export function createTraceServerClient(options?: {
  asHumanCapable?: boolean;
}): TraceApiClient {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!apiUrl || !token) {
    throw new Error(
      "TRACEAI_API_URL and TRACEAI_TOKEN must be set on the web server",
    );
  }
  if (!token.startsWith("trc_")) {
    throw new Error("TRACEAI_TOKEN must start with trc_");
  }
  const humanProxySecret = options?.asHumanCapable
    ? process.env.TRACEAI_HUMAN_PROXY_SECRET?.trim() || undefined
    : undefined;
  return new TraceApiClient({
    apiUrl,
    token,
    humanProxySecret,
  });
}
