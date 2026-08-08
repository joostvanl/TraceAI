import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "traceai_session";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Next internals / static assets
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function userFromToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const expected = bytesToBase64Url(mac);
  if (expected.length !== signature.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload)),
    ) as { user?: unknown; exp?: unknown };
    if (typeof parsed.user !== "string" || !parsed.user) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.TRACEAI_SESSION_SECRET?.trim();
  if (!secret) {
    // Misconfigured deploy: send humans to login (which explains the gap).
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          message: "TRACEAI_SESSION_SECRET is not set on the web server",
          code: "NOT_CONFIGURED",
        },
        { status: 503 },
      );
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  const user = await userFromToken(
    request.cookies.get(SESSION_COOKIE)?.value,
    secret,
  );
  if (user) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { message: "Sign in required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
