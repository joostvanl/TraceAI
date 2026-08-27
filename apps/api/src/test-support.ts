import type { ProjectRole } from "@traceai/core";
import { NotFoundError } from "@traceai/core";

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
  /** Per-project membership default Cursor Cloud id (TRA-128). */
  defaultByProject?: Record<string, string | null>;
}) {
  const userSlug = input.userSlug ?? "tester";
  const role = input.role ?? "admin";
  const memberships = input.projects.map((project) => ({
    id: `id-${project}-${userSlug}`,
    slug: `${project}-member-${userSlug}`,
    fields: {
      project,
      user: userSlug,
      role,
      default_cursor_agent_id:
        input.defaultByProject?.[project]?.trim() || null,
    },
  }));
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
    listProjectMemberships: async (project?: string) =>
      (project
        ? memberships.filter((m) => m.fields.project === project)
        : memberships
      ).map((m) => ({
        ...m,
        fields: { ...m.fields },
      })),
    getOwnMembershipDefaultAgent: async (
      project: string,
      user: string,
    ): Promise<string | null> => {
      const match = memberships.find(
        (m) => m.fields.project === project && m.fields.user === user,
      );
      const value = match?.fields.default_cursor_agent_id?.trim() || "";
      return value || null;
    },
    setOwnMembershipDefaultAgent: async (args: {
      project: string;
      user: string;
      agentId: string;
    }): Promise<string | null> => {
      const match = memberships.find(
        (m) => m.fields.project === args.project && m.fields.user === args.user,
      );
      if (!match) {
        throw new NotFoundError(
          `Project membership not found for ${args.user} on ${args.project}`,
        );
      }
      const value = args.agentId.trim();
      match.fields.default_cursor_agent_id = value || null;
      return value || null;
    },
    setProjectMembership: async (args: {
      project: string;
      user: string;
      role: ProjectRole;
    }) => {
      const match = memberships.find(
        (m) => m.fields.project === args.project && m.fields.user === args.user,
      );
      if (match) {
        match.fields.role = args.role;
        return { ...match, fields: { ...match.fields } };
      }
      const created = {
        id: `id-${args.project}-${args.user}`,
        slug: `${args.project}-member-${args.user}`,
        fields: {
          project: args.project,
          user: args.user,
          role: args.role,
          default_cursor_agent_id: null as string | null,
        },
      };
      memberships.push(created);
      return created;
    },
    listProjectAgents: async () => [],
    assertProjectRole: async () => role,
  };
}
