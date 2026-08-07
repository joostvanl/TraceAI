import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { TraceApiClient, TraceApiError } from "@traceai/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateBody = {
  project?: string;
  title?: string;
  description?: string;
  priority?: string;
  secret?: string;
};

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function createClient(): TraceApiClient {
  const apiUrl = process.env.TRACEAI_API_URL?.replace(/\/$/, "");
  const token = process.env.TRACEAI_TOKEN;
  if (!apiUrl || !token) {
    throw new Error(
      "TRACEAI_API_URL and TRACEAI_TOKEN must be set on the web server",
    );
  }
  if (!token.startsWith("trc_")) {
    throw new Error("TRACEAI_TOKEN must start with trc_");
  }
  return new TraceApiClient({ apiUrl, token });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TRACEAI_CREATE_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { message: "Ticket creation is not configured", code: "NOT_CONFIGURED" },
      { status: 503 },
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

  const secret = body.secret ?? "";
  if (!secretsMatch(secret, expectedSecret)) {
    return NextResponse.json(
      { message: "Invalid create secret", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const project = body.project?.trim() ?? "";
  const title = body.title?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const priority = body.priority?.trim() || "medium";

  if (!project || !title || !description) {
    return NextResponse.json(
      {
        message: "project, title, and description are required",
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }

  if (!["low", "medium", "high"].includes(priority)) {
    return NextResponse.json(
      { message: "priority must be low, medium, or high", code: "VALIDATION" },
      { status: 400 },
    );
  }

  try {
    const client = createClient();
    const ticket = (await client.createTicket({
      project,
      title,
      description,
      priority,
      // First workflow stage — light wishes land here for AI refinement.
      stage: "backlog",
    })) as {
      slug: string;
      title: string;
      stage: string;
      project: string;
      priority?: string;
    };

    return NextResponse.json(
      {
        slug: ticket.slug,
        title: ticket.title,
        stage: ticket.stage,
        project: ticket.project,
        priority: ticket.priority ?? priority,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TraceApiError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code ?? "TRACEAI_ERROR",
        },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { message, code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
