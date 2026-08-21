import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  workflow?: string;
};

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
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
      { message: "Sign in to change ticket workflow", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const { slug } = await context.params;
  if (!slug?.trim()) {
    return NextResponse.json(
      { message: "Ticket slug is required", code: "VALIDATION" },
      { status: 400 },
    );
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const workflow = body.workflow?.trim() ?? "";
  if (!workflow) {
    return NextResponse.json(
      { message: "workflow is required", code: "VALIDATION" },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const ticket = await client.updateTicket(slug, { workflow });
    return NextResponse.json(ticket);
  } catch (error) {
    if (error instanceof TraceApiError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code ?? "TRACEAI_ERROR",
        },
        {
          status:
            error.status >= 400 && error.status < 600 ? error.status : 502,
        },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { message, code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
