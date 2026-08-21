export type NavWorkflow = {
  slug: string;
  name: string;
};

export type ProjectPageKind = "insights" | "wiki" | "settings" | "tokens";

export function boardHref(
  projectSlug: string,
  workflowSlug: string,
  defaultWorkflow: string | null,
): string {
  if (defaultWorkflow && workflowSlug === defaultWorkflow) {
    return `/projects/${projectSlug}`;
  }
  return `/projects/${projectSlug}?workflow=${encodeURIComponent(workflowSlug)}`;
}

export function isBoardActive(input: {
  pathname: string;
  workflowQuery: string | undefined;
  projectSlug: string;
  workflowSlug: string;
  defaultWorkflow: string | null;
}): boolean {
  if (input.pathname !== `/projects/${input.projectSlug}`) return false;
  const selected = input.workflowQuery?.trim() || input.defaultWorkflow;
  return selected === input.workflowSlug;
}

export function isPageActive(
  pathname: string,
  projectSlug: string,
  kind: ProjectPageKind,
): boolean {
  const prefix = `/projects/${projectSlug}/${kind}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function sortWorkflowsForNav(
  workflows: NavWorkflow[],
  defaultWorkflow: string | null,
): NavWorkflow[] {
  return [...workflows].sort((a, b) => {
    if (defaultWorkflow) {
      if (a.slug === defaultWorkflow) return -1;
      if (b.slug === defaultWorkflow) return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Toggle flips; escape / overlay / navigate all pass `"close"`. */
export function menuOpenAfter(
  open: boolean,
  action: "toggle" | "close",
): boolean {
  return action === "toggle" ? !open : false;
}
