import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReorderBody = {
  project?: string;
  stage?: string;
  ordered_slugs?: string[];
};

export async function POST(request: Request) {
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
      { message: "Sign in to reorder tickets", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  let body: ReorderBody;
  try {
    body = (await request.json()) as ReorderBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const project = body.project?.trim() ?? "";
  const stage = body.stage?.trim() ?? "";
  const ordered_slugs = body.ordered_slugs;

  if (!project || !stage || !Array.isArray(ordered_slugs)) {
    return NextResponse.json(
      {
        message: "project, stage, and ordered_slugs are required",
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.reorderTickets({
      project,
      stage,
      ordered_slugs,
    });
    return NextResponse.json(result);
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
