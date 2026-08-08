import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionUser, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReviewBody = {
  verdict?: string;
  comment?: string;
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
  if (verdict !== "approved" && verdict !== "rejected") {
    return NextResponse.json(
      { message: "verdict must be approved or rejected", code: "VALIDATION" },
      { status: 400 },
    );
  }
  const comment = body.comment?.trim() ?? "";
  if (verdict === "rejected" && !comment) {
    return NextResponse.json(
      { message: "A rejection needs a reason", code: "VALIDATION" },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({ asHumanCapable: true });
    const result = await client.recordReviewVerdict(slug, {
      verdict,
      comment,
      reviewer: sessionUser,
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
