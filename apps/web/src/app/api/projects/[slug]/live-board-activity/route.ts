import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ slug: string }>;
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

export async function GET(_request: Request, context: RouteContext) {
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
  const { slug } = await context.params;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.getProjectLiveBoardActivity(slug);
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
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
  const { slug } = await context.params;
  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { message: "enabled must be a boolean", code: "VALIDATION" },
      { status: 400 },
    );
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.putProjectLiveBoardActivity(slug, body.enabled);
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}
