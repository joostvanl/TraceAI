import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  cookieShouldBeSecure,
  sessionCookieOptions,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    "",
    sessionCookieOptions(0, cookieShouldBeSecure(request)),
  );
  return response;
}
