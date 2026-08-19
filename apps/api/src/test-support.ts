import type { ProjectRole } from "@traceai/core";

/**
 * Service stubs that let a bearer token in a test resolve to a member of a
 * project (TRA-82).
 *
 * Since project-scoped routes check membership, a service double that only
 * implements the method under test now fails with "not a function" surfacing as
 * a 400. Every such double needs the same three stubs, so they live here once.
 *
 * `assertProjectRole` resolves successfully on purpose: these doubles belong to
 * tests about reorder/wiki/transition behaviour, and letting them also assert
 * role logic would duplicate — and eventually contradict — the R-series in
 * `project-access.test.ts`, which exercises the real thing.
 */
export function projectMemberStubs(input: {
  /** Must match the AuthStore user's email: that is how the token maps to a user. */
  email: string;
  projects: string[];
  userSlug?: string;
  role?: ProjectRole;
}) {
  const userSlug = input.userSlug ?? "tester";
  const role = input.role ?? "admin";
  return {
    listTraceaiUsers: async () => [
      {
        id: `id-${userSlug}`,
        slug: userSlug,
        fields: {
          username: userSlug,
          email: input.email,
          status: "active",
          is_platform_admin: false,
        },
      },
    ],
    listProjectMemberships: async () =>
      input.projects.map((project) => ({
        id: `id-${project}-${userSlug}`,
        slug: `${project}-member-${userSlug}`,
        fields: { project, user: userSlug, role },
      })),
    assertProjectRole: async () => role,
  };
}
