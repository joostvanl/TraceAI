/**
 * Secure cookies are rejected by browsers on http:// LAN hosts. The Docker
 * image always has NODE_ENV=production, so that is the wrong signal.
 * Use TRACEAI_COOKIE_SECURE=0|1 to force; otherwise follow the request proto
 * (X-Forwarded-Proto, then the URL). Cloudflare HTTPS still gets Secure.
 */
export function cookieShouldBeSecure(request: Request): boolean {
  const override = process.env.TRACEAI_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieOptions(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge,
  };
}
