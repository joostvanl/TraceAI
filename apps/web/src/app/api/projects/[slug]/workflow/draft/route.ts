import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";
import { getProject } from "@/lib/cms";
import { hasProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, context: RouteContext) {
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
  // `saveWorkflowDraft` is not project-scoped, so membership is checked here
  // (TRA-81).
  if (!(await hasProjectAccess(slug, identity))) {
    return NextResponse.json(
      { message: "Project not found", code: "NOT_FOUND" },
      { status: 404 },
    );
  }
  const project = await getProject(slug);
  const workflowSlug = project?.fields.default_workflow;
  if (!workflowSlug) {
    return NextResponse.json(
      { message: "Project or default workflow not found", code: "NOT_FOUND" },
      { status: 404 },
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = await client.saveWorkflowDraft(workflowSlug, {
      ...body,
      saved_by: identity.display_name || identity.slug,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TraceApiError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code ?? "TRACEAI_ERROR",
          issues:
            typeof error.body === "object" &&
            error.body &&
            "issues" in error.body
              ? (error.body as { issues: unknown }).issues
              : undefined,
        },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : String(error), code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
