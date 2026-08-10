import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";
import { getProject } from "@/lib/cms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

async function resolveWorkflowSlug(projectSlug: string) {
  const project = await getProject(projectSlug);
  if (!project) return null;
  const workflowSlug = project.fields.default_workflow;
  if (!workflowSlug) return null;
  return { project, workflowSlug };
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
  const resolved = await resolveWorkflowSlug(slug);
  if (!resolved) {
    return NextResponse.json(
      { message: "Project or default workflow not found", code: "NOT_FOUND" },
      { status: 404 },
    );
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const workflow = await client.getWorkflow(resolved.workflowSlug);
    return NextResponse.json(workflow);
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
