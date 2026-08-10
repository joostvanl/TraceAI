import { TraceApiClient } from "@traceai/core";
import {
  getSessionIdentity,
  signHumanIdentityHeader,
  type SessionIdentity,
} from "@/lib/session";

/** Server-side TraceAI API client (create + human-gated transitions). */
export function createTraceServerClient(options?: {
  asHumanCapable?: boolean;
  identity?: SessionIdentity | null;
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
  const identity = options?.identity;
  const humanIdentityHeader =
    options?.asHumanCapable && identity
      ? signHumanIdentityHeader(identity)
      : undefined;
  return new TraceApiClient({
    apiUrl,
    token,
    humanProxySecret,
    humanIdentityHeader,
  });
}

export async function createHumanTraceClient(): Promise<{
  client: TraceApiClient;
  identity: SessionIdentity;
} | null> {
  const identity = await getSessionIdentity();
  if (!identity) return null;
  return {
    client: createTraceServerClient({
      asHumanCapable: true,
      identity,
    }),
    identity,
  };
}
