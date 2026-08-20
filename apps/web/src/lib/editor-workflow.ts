import { editorWorkflowSlugForRequest, relationSlug } from "@traceai/core";
import { getProject, listWorkflowsForProject } from "@/lib/cms";

export async function resolveEditorWorkflowSlug(
  projectSlug: string,
  request: Request,
): Promise<string | null> {
  const requested =
    new URL(request.url).searchParams.get("workflow")?.trim() || "";
  const project = await getProject(projectSlug);
  if (!project) return null;
  const defaultWorkflow = relationSlug(project.fields.default_workflow);
  const owned = await listWorkflowsForProject(projectSlug);
  return editorWorkflowSlugForRequest({
    requested: requested || undefined,
    defaultWorkflow,
    projectWorkflowSlugs: owned.map((workflow) => workflow.slug),
  });
}
