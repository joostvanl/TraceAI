import type { ProjectRole } from "@traceai/core";
import {
  projectDefaultFieldState,
  roleAtLeast,
  uniqueMembershipBcDefault,
} from "@traceai/core";

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
  /**
   * Project-owned default Cursor Cloud id (TRA-137). When set, the project
   * field is already written (including `null` = cleared). When omitted, the
   * field is absent so the first empty read may copy a membership `bc-`.
   */
  defaultByProject?: Record<string, string | null>;
  /** Leftover TRA-128 membership defaults, used only for first-empty-read copy. */
  membershipDefaultByProject?: Record<string, string | null>;
  isPlatformAdmin?: boolean;
  /** When true, `assertProjectRole` checks `role` against `required`. */
  enforceRoles?: boolean;
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
        input.membershipDefaultByProject?.[project]?.trim() || null,
    },
  }));
  const projectDefaults = new Map<
    string,
    { written: boolean; value: string | null }
  >();
  for (const project of input.projects) {
    if (
      input.defaultByProject &&
      Object.prototype.hasOwnProperty.call(input.defaultByProject, project)
    ) {
      const raw = input.defaultByProject[project];
      const state = projectDefaultFieldState(raw ?? "");
      projectDefaults.set(project, { written: true, value: state.value });
    }
  }
  return {
    listTraceaiUsers: async () => [
      {
        id: `id-${userSlug}`,
        slug: userSlug,
        fields: {
          username: userSlug,
          email: input.email,
          status: "active",
          is_platform_admin: input.isPlatformAdmin === true,
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
    getProjectDefaultAgent: async (project: string): Promise<string | null> => {
      const existing = projectDefaults.get(project);
      if (existing?.written) return existing.value;
      const copied = uniqueMembershipBcDefault(
        memberships
          .filter((m) => m.fields.project === project)
          .map((m) => m.fields.default_cursor_agent_id),
      );
      projectDefaults.set(project, { written: true, value: copied });
      return copied;
    },
    setProjectDefaultAgent: async (args: {
      project: string;
      agentId: string;
    }): Promise<string | null> => {
      const value = args.agentId.trim() || null;
      projectDefaults.set(args.project, { written: true, value });
      return value;
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
    assertProjectRole: async (args: {
      projectSlug: string;
      required: ProjectRole;
      isPlatformAdmin?: boolean;
    }) => {
      if (args.isPlatformAdmin || input.isPlatformAdmin) return "platform_admin";
      if (input.enforceRoles && !roleAtLeast(role, args.required)) {
        throw new Error(
          `Requires project role ${args.required} on ${args.projectSlug} (have ${role})`,
        );
      }
      return role;
    },
  };
}
