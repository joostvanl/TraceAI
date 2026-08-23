import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cookieShouldBeSecure } from "./session-cookie.ts";

describe("cookieShouldBeSecure", () => {
  const prev = process.env.TRACEAI_COOKIE_SECURE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TRACEAI_COOKIE_SECURE;
    else process.env.TRACEAI_COOKIE_SECURE = prev;
  });

  it("keeps the cookie usable on LAN HTTP even when NODE_ENV is production", () => {
    delete process.env.TRACEAI_COOKIE_SECURE;
    const request = new Request("http://192.168.1.185:3011/api/auth/login");
    assert.equal(cookieShouldBeSecure(request), false);
  });

  it("sets Secure behind a TLS proxy", () => {
    delete process.env.TRACEAI_COOKIE_SECURE;
    const request = new Request("http://127.0.0.1:3011/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(cookieShouldBeSecure(request), true);
  });

  it("honours TRACEAI_COOKIE_SECURE=0 on HTTPS", () => {
    process.env.TRACEAI_COOKIE_SECURE = "0";
    const request = new Request("https://traceai.example/api/auth/login");
    assert.equal(cookieShouldBeSecure(request), false);
  });
});
