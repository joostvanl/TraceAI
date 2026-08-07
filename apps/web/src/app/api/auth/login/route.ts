import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isLoginConfigured,
  sessionCookieOptions,
  verifyCredentials,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginBody = {
  username?: string;
  password?: string;
};

export async function POST(request: Request) {
  if (!isLoginConfigured()) {
    return NextResponse.json(
      {
        message:
          "UI login is not configured. Set TRACEAI_UI_USER and TRACEAI_UI_PASSWORD on the web server.",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";

  if (!verifyCredentials(username, password)) {
    return NextResponse.json(
      { message: "Invalid username or password", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ user: username });
  response.cookies.set(
    SESSION_COOKIE,
    createSessionToken(username),
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS),
  );
  return response;
}
