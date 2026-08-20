import Link from "next/link";

export type SwitcherWorkflow = {
  slug: string;
  name: string;
};

type Props = {
  projectSlug: string;
  workflows: SwitcherWorkflow[];
  selectedWorkflow: string;
  defaultWorkflow: string | null;
};

export function WorkflowSwitcher({
  projectSlug,
  workflows,
  selectedWorkflow,
  defaultWorkflow,
}: Props) {
  if (workflows.length === 0) return null;

  return (
    <nav className="workflow-switcher" aria-label="Workflow boards">
      {workflows.map((workflow) => {
        const isDefault = defaultWorkflow === workflow.slug;
        const href = isDefault
          ? `/projects/${projectSlug}`
          : `/projects/${projectSlug}?workflow=${encodeURIComponent(workflow.slug)}`;
        const active = workflow.slug === selectedWorkflow;
        return (
          <Link
            key={workflow.slug}
            href={href}
            className={`workflow-switcher-item${active ? " workflow-switcher-item--active" : ""}`}
          >
            {workflow.name}
            {isDefault ? " (default)" : ""}
          </Link>
        );
      })}
    </nav>
  );
}
