import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET() {
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
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.listMyAgentApis();
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}

export async function PUT(request: Request) {
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
  let body: { provider?: string; api_key?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }
  const provider = body.provider?.trim() || "cursor";
  if (!body.api_key?.trim()) {
    return NextResponse.json(
      { message: "api_key is required", code: "VALIDATION" },
      { status: 400 },
    );
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.putMyAgentApi(provider, body.api_key.trim());
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}

export async function DELETE(request: Request) {
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
  const provider =
    new URL(request.url).searchParams.get("provider")?.trim() || "cursor";
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.deleteMyAgentApi(provider);
    return NextResponse.json(result);
  } catch (error) {
    return proxyError(error);
  }
}
