import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { relationSlug } from "@traceai/core";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { getProject, listWorkflowsForProject } from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";
import { sortWorkflowsForNav } from "@/lib/project-nav";

export const dynamic = "force-dynamic";

type Props = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

export default async function ProjectLayout({ children, params }: Props) {
  const { slug } = await params;
  await requireProjectAccess(slug);
  const project = await getProject(slug);
  if (!project) notFound();

  const projectWorkflows = await listWorkflowsForProject(slug);
  const defaultWorkflow = relationSlug(project.fields.default_workflow);
  const workflows = sortWorkflowsForNav(
    projectWorkflows.map((workflow) => ({
      slug: workflow.slug,
      name: workflow.fields.name,
    })),
    defaultWorkflow,
  );

  return (
    <div className="project-shell">
      <Suspense fallback={null}>
        <ProjectSidebar
          projectSlug={slug}
          projectName={project.fields.name}
          workflows={workflows}
          defaultWorkflow={defaultWorkflow}
        />
      </Suspense>
      <div className="project-shell-main">{children}</div>
    </div>
  );
}
