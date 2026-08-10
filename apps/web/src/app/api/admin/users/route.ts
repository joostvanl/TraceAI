import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requirePlatformAdmin() {
  if (!(await isLoginConfigured())) {
    return {
      error: NextResponse.json(
        { message: "UI login is not configured", code: "NOT_CONFIGURED" },
        { status: 503 },
      ),
    };
  }
  const identity = await getSessionIdentity();
  if (!identity) {
    return {
      error: NextResponse.json(
        { message: "Sign in required", code: "UNAUTHORIZED" },
        { status: 401 },
      ),
    };
  }
  if (!identity.is_platform_admin && identity.mode !== "legacy") {
    return {
      error: NextResponse.json(
        { message: "Platform admin required", code: "FORBIDDEN" },
        { status: 403 },
      ),
    };
  }
  return { identity };
}

export async function GET() {
  const gate = await requirePlatformAdmin();
  if ("error" in gate && gate.error) return gate.error;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity: gate.identity!,
    });
    const users = await client.listTraceaiUsers();
    return NextResponse.json(users);
  } catch (error) {
    if (error instanceof TraceApiError) {
      return NextResponse.json(
        { message: error.message, code: error.code ?? "TRACEAI_ERROR" },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : String(error), code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const gate = await requirePlatformAdmin();
  if ("error" in gate && gate.error) return gate.error;
  let body: {
    username?: string;
    password?: string;
    display_name?: string;
    email?: string;
    is_platform_admin?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity: gate.identity!,
    });
    const user = await client.createTraceaiUser({
      username: body.username ?? "",
      password: body.password ?? "",
      display_name: body.display_name ?? body.username ?? "",
      email: body.email,
      is_platform_admin: body.is_platform_admin === true,
    });
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof TraceApiError) {
      return NextResponse.json(
        { message: error.message, code: error.code ?? "TRACEAI_ERROR" },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : String(error), code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
