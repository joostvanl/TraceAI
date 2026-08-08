import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionUser, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TransitionBody = {
  to_stage?: string;
  comment?: string;
  tokens_estimate?: number;
  tokens_used?: number;
  resolution?: string;
};

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  if (!(await isLoginConfigured())) {
    return NextResponse.json(
      {
        message:
          "UI login is not configured in Aurora. Set Username + Password on app_login / default.",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json(
      { message: "Sign in to approve or reject tickets", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  if (!process.env.TRACEAI_HUMAN_PROXY_SECRET?.trim()) {
    return NextResponse.json(
      {
        message:
          "TRACEAI_HUMAN_PROXY_SECRET is not configured on the web server (required for human approval).",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const { slug } = await context.params;
  if (!slug?.trim()) {
    return NextResponse.json(
      { message: "Ticket slug is required", code: "VALIDATION" },
      { status: 400 },
    );
  }

  let body: TransitionBody;
  try {
    body = (await request.json()) as TransitionBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const toStage = body.to_stage?.trim() ?? "";
  const comment = body.comment?.trim() ?? "";
  if (!toStage || !comment) {
    return NextResponse.json(
      {
        message: "to_stage and comment are required",
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({ asHumanCapable: true });
    const result = await client.transitionTicket(slug, toStage, comment, {
      tokens_estimate: body.tokens_estimate,
      tokens_used: body.tokens_used ?? 0,
      resolution: body.resolution,
      asHuman: true,
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
