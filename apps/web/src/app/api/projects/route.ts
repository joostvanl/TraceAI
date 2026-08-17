import { NextResponse } from "next/server";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateBody = {
  name?: string;
  description?: string;
  slug?: string;
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
      { message: "Sign in to create a project", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const name = body.name?.trim() ?? "";
  const description = body.description?.trim() || undefined;
  const slug = body.slug?.trim() || undefined;

  if (!name) {
    return NextResponse.json(
      { message: "name is required", code: "VALIDATION" },
      { status: 400 },
    );
  }

  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const result = (await client.createProject({
      name,
      description,
      slug,
      seed_workflow: true,
      seed_wiki: true,
    })) as {
      project?: { slug?: string; name?: string };
      workflow?: { slug?: string } | null;
    };
    return NextResponse.json(result, { status: 201 });
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
