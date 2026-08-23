import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isLoginConfigured,
  cookieShouldBeSecure,
  sessionCookieOptions,
  sessionSecret,
  verifyCredentials,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginBody = {
  username?: string;
  password?: string;
};

export async function POST(request: Request) {
  if (!sessionSecret()) {
    return NextResponse.json(
      {
        message: "TRACEAI_SESSION_SECRET is not set on the web server.",
        code: "NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

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

  const result = await verifyCredentials(username, password);
  if (!result.ok) {
    if (!result.configured) {
      return NextResponse.json(
        {
          message:
            "UI login is not configured in Aurora. Set Username + Password on app_login / default.",
          code: "NOT_CONFIGURED",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { message: "Invalid username or password", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    user: result.user,
    identity: result.identity,
  });
  response.cookies.set(
    SESSION_COOKIE,
    createSessionToken(result.identity),
    sessionCookieOptions(
      SESSION_MAX_AGE_SECONDS,
      cookieShouldBeSecure(request),
    ),
  );
  return response;
}
