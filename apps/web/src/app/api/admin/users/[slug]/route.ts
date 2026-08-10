import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

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

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await requirePlatformAdmin();
  if ("error" in gate && gate.error) return gate.error;
  const { slug } = await context.params;
  let body: {
    display_name?: string;
    email?: string | null;
    status?: string;
    is_platform_admin?: boolean;
    password?: string;
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
    const user = await client.updateTraceaiUser(slug, {
      display_name: body.display_name,
      email: body.email,
      status: body.status,
      is_platform_admin: body.is_platform_admin,
      password: body.password,
    });
    return NextResponse.json(user);
  } catch (error) {
    return proxyError(error);
  }
}
