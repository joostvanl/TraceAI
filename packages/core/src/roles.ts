/**
 * Project-scoped roles for TraceAI humans (Aurora-backed memberships).
 * Distinct from bearer token `admin` scope (platform/agent capability).
 */

export const PROJECT_ROLES = ["viewer", "editor", "admin"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (PROJECT_ROLES as readonly string[]).includes(value)
  );
}

export function roleAtLeast(
  actual: ProjectRole | null | undefined,
  required: ProjectRole,
): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Minimum role for common project actions. */
export function requiredRoleForAction(
  action:
    | "read"
    | "write_tickets"
    | "review"
    | "write_wiki"
    | "write_workflow"
    | "manage_members",
): ProjectRole {
  switch (action) {
    case "read":
      return "viewer";
    case "write_tickets":
    case "review":
    case "write_wiki":
      return "editor";
    case "write_workflow":
    case "manage_members":
      return "admin";
  }
}

/**
 * Deterministic entry slug for a membership. Aurora rejects `--`, so the parts
 * are joined with a single-dash keyword instead.
 */
/**
 * Deterministic entry slug for a membership. Aurora rejects `--`, so the parts
 * are joined with a single-dash keyword instead.
 */
export function membershipSlug(projectSlug: string, userSlug: string): string {
  return `${projectSlug}-member-${userSlug}`;
}

type PlatformAdminCandidate = {
  slug: string;
  status: string;
  is_platform_admin?: boolean;
};

function isActivePlatformAdmin(user: PlatformAdminCandidate): boolean {
  return user.is_platform_admin === true && user.status === "active";
}

/**
 * True when applying `next` to `targetSlug` would leave zero active
 * platform admins (last-admin lockout guard).
 */
export function wouldRemoveLastPlatformAdmin(
  users: PlatformAdminCandidate[],
  targetSlug: string,
  next: { status?: string; is_platform_admin?: boolean },
): boolean {
  const target = users.find((u) => u.slug === targetSlug);
  if (!target || !isActivePlatformAdmin(target)) return false;

  const nextStatus = next.status ?? target.status;
  const nextIsAdmin =
    next.is_platform_admin !== undefined
      ? next.is_platform_admin
      : target.is_platform_admin === true;
  if (nextIsAdmin && nextStatus === "active") return false;

  return !users.some(
    (u) => u.slug !== targetSlug && isActivePlatformAdmin(u),
  );
}
