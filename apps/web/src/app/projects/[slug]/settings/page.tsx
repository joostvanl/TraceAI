import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { WorkflowDocument } from "@traceai/core";
import { ProjectMembersPanel } from "@/components/ProjectMembersPanel";
import { WorkflowEditorPanel } from "@/components/WorkflowEditorPanel";
import { getProject } from "@/lib/cms";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type SettingsTab = "workflow" | "members";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const { tab } = await searchParams;
  const activeTab: SettingsTab = tab === "members" ? "members" : "workflow";
  const configured = await isLoginConfigured();
  if (!configured) redirect("/login");
  const identity = await getSessionIdentity();
  if (!identity) redirect("/login");

  const project = await getProject(slug);
  if (!project) notFound();

  let members: Array<{
    slug: string;
    project: string;
    user: string;
    role: string;
  }> = [];
  let users: Array<{
    slug: string;
    username: string;
    display_name: string;
  }> = [];
  let loadError: string | null = null;
  let workflowPayload: {
    slug: string;
    name: string;
    project: string;
    workflow_document: WorkflowDocument;
  } | null = null;

  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    members = (await client.listProjectMembers(slug)) as typeof members;
    if (identity.is_platform_admin || identity.mode === "legacy") {
      users = ((await client.listTraceaiUsers()) as Array<{
        slug: string;
        username: string;
        display_name: string;
      }>).map((u) => ({
        slug: u.slug,
        username: u.username,
        display_name: u.display_name,
      }));
    }
    const workflowSlug = project.fields.default_workflow;
    if (workflowSlug) {
      const workflow = (await client.getWorkflow(workflowSlug)) as {
        slug: string;
        name: string;
        project: string;
        workflow_document: WorkflowDocument;
      };
      workflowPayload = {
        slug: workflow.slug,
        name: workflow.name,
        project: workflow.project,
        workflow_document: workflow.workflow_document,
      };
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="panel">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>Settings</span>
      </nav>
      <h1>Projectinstellingen</h1>

      <nav className="settings-tabs" aria-label="Instellingen">
        <Link
          href={`/projects/${slug}/settings?tab=workflow`}
          className={`settings-tab${activeTab === "workflow" ? " settings-tab--active" : ""}`}
          aria-current={activeTab === "workflow" ? "page" : undefined}
        >
          Workflow
        </Link>
        <Link
          href={`/projects/${slug}/settings?tab=members`}
          className={`settings-tab${activeTab === "members" ? " settings-tab--active" : ""}`}
          aria-current={activeTab === "members" ? "page" : undefined}
        >
          Leden
        </Link>
      </nav>

      {loadError ? <p className="form-error">{loadError}</p> : null}

      {activeTab === "workflow" ? (
        <section className="settings-tab-panel">
          <p className="muted">
            Visuele workflow-editor: stages als blokken, transitions als pijlen.
            Dubbelklik een stage of pijl om de tekstuele eigenschappen onder het
            canvas te bewerken.
          </p>
          {workflowPayload ? (
            <WorkflowEditorPanel projectSlug={slug} initial={workflowPayload} />
          ) : (
            <p className="muted">Geen default workflow geconfigureerd.</p>
          )}
        </section>
      ) : (
        <section className="settings-tab-panel">
          <p className="muted">Leden en rollen voor dit project.</p>
          <ProjectMembersPanel
            projectSlug={slug}
            members={members}
            users={users}
          />
          {!identity.is_platform_admin && identity.mode !== "legacy" ? (
            <p className="muted">
              Nieuwe leden toevoegen vereist dat gebruikers al bestaan (via{" "}
              <Link href="/admin/users">Admin · Gebruikers</Link>) en dat jij
              project-admin bent.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
