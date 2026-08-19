import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraceApiClient } from "./api-client.js";

/**
 * TRA-81. `/v1/me/projects` requires a human identity, and since TRA-81 the API
 * answers `/v1/projects` and `/v1/projects/:slug` per principal. A client that
 * omits the identity is therefore judged as the web server's own token, which
 * carries admin scope — so the caller sees every project and any membership
 * check is meaningless.
 *
 * That is exactly what happened: `listMyProjects` never sent the identity, the
 * call 401'd, and the homepage quietly fell back to Aurora's full project list.
 * Removing that fallback is what finally made the bug visible. This test makes
 * the header a requirement instead of a habit.
 */
describe("human identity forwarding (TRA-81)", () => {
  function clientRecording(paths: Array<{ path: string; hasIdentity: boolean }>) {
    return new TraceApiClient({
      apiUrl: "http://api.test",
      token: "trc_test",
      humanProxySecret: "proxy-secret",
      humanIdentityHeader: "signed.identity",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        paths.push({
          path: new URL(String(url)).pathname,
          hasIdentity:
            headers.has("X-TraceAI-Human-Identity") &&
            headers.has("X-TraceAI-Human-Proxy"),
        });
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
  }

  it("sends the identity on the project read paths", async () => {
    const calls: Array<{ path: string; hasIdentity: boolean }> = [];
    const client = clientRecording(calls);

    await client.listMyProjects();
    await client.listProjects();
    await client.getProject("traceai");

    const missing = calls.filter((c) => !c.hasIdentity).map((c) => c.path);
    assert.deepEqual(
      missing,
      [],
      "these paths went out without the human identity, so the API would judge the server token instead of the user",
    );
    assert.deepEqual(calls.map((c) => c.path), [
      "/v1/me/projects",
      "/v1/projects",
      "/v1/projects/traceai",
    ]);
  });

  it("omits the headers when the client has no identity to send", async () => {
    const calls: Array<{ path: string; hasIdentity: boolean }> = [];
    // An agent token client: no identity, so nothing to forward. It must not
    // invent one, or an agent would masquerade as a human.
    const client = new TraceApiClient({
      apiUrl: "http://api.test",
      token: "trc_agent",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          path: new URL(String(url)).pathname,
          hasIdentity: headers.has("X-TraceAI-Human-Identity"),
        });
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.listProjects();
    await client.getProject("traceai");
    assert.deepEqual(calls.filter((c) => c.hasIdentity), []);
  });
});
