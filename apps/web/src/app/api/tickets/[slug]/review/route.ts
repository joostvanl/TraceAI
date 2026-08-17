import { NextResponse } from "next/server";
import {
  isTicketReviewState,
  TICKET_REVIEW_STATES,
  TraceApiError,
} from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReviewBody = {
  verdict?: string;
  comment?: string;
  apply_to_children?: boolean;
};

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
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
      { message: "Sign in to approve or reject tickets", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  if (!process.env.TRACEAI_HUMAN_PROXY_SECRET?.trim()) {
    return NextResponse.json(
      {
        message:
          "TRACEAI_HUMAN_PROXY_SECRET is not configured on the web server (required for human review).",
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

  let body: ReviewBody;
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const verdict = body.verdict?.trim();
  if (!isTicketReviewState(verdict)) {
    return NextResponse.json(
      {
        message: `verdict must be one of: ${TICKET_REVIEW_STATES.join(", ")}`,
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }
  const comment = body.comment?.trim() ?? "";
  if (verdict !== "approved" && !comment) {
    return NextResponse.json(
      { message: "This verdict needs a reason", code: "VALIDATION" },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.recordReviewVerdict(slug, {
      verdict,
      comment,
      reviewer: identity.slug || identity.user,
      apply_to_children: body.apply_to_children === true,
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
