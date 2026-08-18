import { notFound } from "next/navigation";
import { TraceApiError } from "@traceai/core";
import { getSessionIdentity, type SessionIdentity } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

/**
 * The membership check itself: `GET /v1/projects/:slug` is gated by the API's
 * project-access middleware, so a 404 there is the answer. Throws on failure.
 */
async function assertAccess(
  slug: string,
  identity: SessionIdentity,
): Promise<void> {
  const client = createTraceServerClient({ asHumanCapable: true, identity });
  await client.getProject(slug);
}

/**
 * Route-handler variant of {@link requireProjectAccess}: returns false instead of
 * rendering a 404 page, so the caller can answer with JSON. Rethrows anything
 * that is not an access answer.
 */
export async function hasProjectAccess(
  slug: string,
  identity: SessionIdentity,
): Promise<boolean> {
  try {
    await assertAccess(slug, identity);
    return true;
  } catch (error) {
    if (
      error instanceof TraceApiError &&
      (error.status === 404 || error.status === 403)
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * TRA-81: gate for every page under `/projects/[slug]`.
 *
 * The pages still read their data straight from Aurora (TRA-78), and Aurora only
 * knows a shared site key — it cannot express a membership. So the check has to
 * be made against the TraceAI API, with the signed human identity, before the
 * page renders anything.
 *
 * Not a `layout.tsx`: Next.js may reuse a rendered layout across navigations, so
 * a layout is not a dependable boundary. Every page calls this instead, and
 * `project-access.guard.test.ts` fails when a page forgets to.
 *
 * Always `notFound()`, never a "no access" page: whether someone else's project
 * exists is itself information.
 */
export async function requireProjectAccess(slug: string): Promise<void> {
  const identity = await getSessionIdentity();
  if (!identity) notFound();

  try {
    await assertAccess(slug, identity);
  } catch (error) {
    if (
      error instanceof TraceApiError &&
      (error.status === 404 || error.status === 403)
    ) {
      notFound();
    }
    // Anything else is a failure, not an answer. Rethrowing shows the error page
    // instead of quietly rendering a 404 over a broken API — and it still keeps
    // the page closed.
    throw error;
  }
}
