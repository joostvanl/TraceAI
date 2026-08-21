import { NextResponse } from "next/server";
import { getSessionIdentity, isLoginConfigured, signHumanIdentityHeader } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin SSE proxy (TRA-84). Browser EventSource cannot send
 * Authorization; the session cookie lives on this origin. Membership is
 * enforced on the API — this route only forwards identity.
 */
export async function GET(request: Request) {
  if (!(await isLoginConfigured())) {
    return NextResponse.json(
      {
        message:
          "UI login is not configured. Create a TraceAI user or set legacy app_login.",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const identity = await getSessionIdentity();
  if (!identity) {
    return NextResponse.json(
      { message: "Sign in required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  const proxySecret = process.env.TRACEAI_HUMAN_PROXY_SECRET?.trim();
  if (!apiUrl || !token || !proxySecret) {
    return NextResponse.json(
      {
        message:
          "TRACEAI_API_URL, TRACEAI_TOKEN, and TRACEAI_HUMAN_PROXY_SECRET must be set on the web server",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const incoming = new URL(request.url);
  const upstream = new URL(`${apiUrl}/events`);
  const project = incoming.searchParams.get("project")?.trim() ?? "";
  const after = incoming.searchParams.get("after")?.trim() ?? "";
  if (project) upstream.searchParams.set("project", project);
  if (after) upstream.searchParams.set("after", after);

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "text/event-stream");
  const lastEventId =
    request.headers.get("Last-Event-ID") ??
    request.headers.get("last-event-id");
  if (lastEventId) headers.set("Last-Event-ID", lastEventId);

  headers.set("X-TraceAI-Human-Proxy", proxySecret);
  headers.set("X-TraceAI-Human-Identity", signHumanIdentityHeader(identity));

  const upstreamRes = await fetch(upstream, {
    headers,
    signal: request.signal,
    cache: "no-store",
  });

  if (!upstreamRes.ok || !upstreamRes.body) {
    const body = await upstreamRes.text();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        "Content-Type":
          upstreamRes.headers.get("Content-Type") ?? "application/json",
      },
    });
  }

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
