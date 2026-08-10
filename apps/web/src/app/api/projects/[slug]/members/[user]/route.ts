import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ slug: string; user: string }>;
};

function proxyError(error: unknown) {
  if (error instanceof TraceApiError) {
    return NextResponse.json(
      { message: error.message, code: error.code ?? "TRACEAI_ERROR" },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
    );
  }
  return NextResponse.json(
    {
      message: error instanceof Error ? error.message : String(error),
      code: "PROXY_ERROR",
    },
    { status: 502 },
  );
}

export async function DELETE(_request: Request, context: RouteContext) {
  if (!(await isLoginConfigured())) {
    return NextResponse.json(
      { message: "UI login is not configured", code: "NOT_CONFIGURED" },
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
  const { slug, user } = await context.params;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.removeProjectMember(slug, user);
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}
