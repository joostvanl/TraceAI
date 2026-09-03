import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  editorWorkflowSlugForRequest,
  relationSlug,
  type WorkflowDocument,
} from "@traceai/core";
import { ProjectAgentsPanel } from "@/components/ProjectAgentsPanel";
import { ProjectDefaultAgentPanel } from "@/components/ProjectDefaultAgentPanel";
import { ProjectFeaturesPanel } from "@/components/ProjectFeaturesPanel";
import { ProjectMembersPanel } from "@/components/ProjectMembersPanel";
import { WorkflowEditorPanel } from "@/components/WorkflowEditorPanel";
import { WorkflowEditorToolbar } from "@/components/WorkflowEditorToolbar";
import { getProject } from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type SettingsTab =
  | "workflow"
  | "members"
  | "default-agent"
  | "agents"
  | "features";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; workflow?: string }>;
};

function firstQuery(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const activeTab: SettingsTab =
    query.tab === "members"
      ? "members"
      : query.tab === "default-agent"
        ? "default-agent"
        : query.tab === "agents"
          ? "agents"
          : query.tab === "features"
            ? "features"
            : "workflow";
  const requestedWorkflow = firstQuery(query.workflow);
  const configured = await isLoginConfigured();
  if (!configured) redirect("/login");
  const identity = await getSessionIdentity();
  if (!identity) redirect("/login");
  await requireProjectAccess(slug);

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
  let editorWorkflows: Array<{ slug: string; name: string }> = [];
  let selectedWorkflow: string | null = relationSlug(
    project.fields.default_workflow,
  );
  let cloneSources: Array<{ slug: string; name: string; project: string }> = [];

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
    const listed = (await client.listWorkflows(slug)) as Array<{
      slug: string;
      name: string;
      project?: string;
    }>;
    const defaultWorkflow = relationSlug(project.fields.default_workflow);
    editorWorkflows = listed.map((workflow) => ({
      slug: workflow.slug,
      name: workflow.name || workflow.slug,
    }));
    if (
      defaultWorkflow &&
      !editorWorkflows.some((workflow) => workflow.slug === defaultWorkflow)
    ) {
      editorWorkflows.unshift({
        slug: defaultWorkflow,
        name: defaultWorkflow,
      });
    }
    selectedWorkflow = editorWorkflowSlugForRequest({
      requested: requestedWorkflow,
      defaultWorkflow,
      projectWorkflowSlugs: editorWorkflows.map((workflow) => workflow.slug),
    });
    if (requestedWorkflow && !selectedWorkflow) notFound();
    if (selectedWorkflow) {
      const workflow = (await client.getWorkflow(selectedWorkflow)) as {
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
    if (identity.is_platform_admin) {
      const all = (await client.listWorkflows()) as Array<{
        slug: string;
        name: string;
        project?: string | null;
      }>;
      cloneSources = all
        .filter((workflow) => relationSlug(workflow.project) !== slug)
        .map((workflow) => ({
          slug: workflow.slug,
          name: workflow.name || workflow.slug,
          project: relationSlug(workflow.project) || "(geen project)",
        }));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const membershipRole = members.find(
    (member) => member.user === identity.slug,
  )?.role;
  const canWriteWorkflow =
    identity.is_platform_admin ||
    identity.mode === "legacy" ||
    membershipRole === "admin";

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
        <Link
          href={`/projects/${slug}/settings?tab=default-agent`}
          className={`settings-tab${activeTab === "default-agent" ? " settings-tab--active" : ""}`}
          aria-current={activeTab === "default-agent" ? "page" : undefined}
        >
          Default agent
        </Link>
        <Link
          href={`/projects/${slug}/settings?tab=agents`}
          className={`settings-tab${activeTab === "agents" ? " settings-tab--active" : ""}`}
          aria-current={activeTab === "agents" ? "page" : undefined}
        >
          Agents
        </Link>
        <Link
          href={`/projects/${slug}/settings?tab=features`}
          className={`settings-tab${activeTab === "features" ? " settings-tab--active" : ""}`}
          aria-current={activeTab === "features" ? "page" : undefined}
        >
          Functies
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
          {selectedWorkflow ? (
            <WorkflowEditorToolbar
              projectSlug={slug}
              workflows={editorWorkflows}
              selectedSlug={selectedWorkflow}
              defaultSlug={relationSlug(project.fields.default_workflow)}
              canWriteWorkflow={canWriteWorkflow}
              isPlatformAdmin={identity.is_platform_admin === true}
              cloneSources={cloneSources}
            />
          ) : null}
          {workflowPayload ? (
            <WorkflowEditorPanel
              key={workflowPayload.slug}
              projectSlug={slug}
              initial={workflowPayload}
            />
          ) : (
            <p className="muted">Geen default workflow geconfigureerd.</p>
          )}
        </section>
      ) : activeTab === "default-agent" ? (
        <section className="settings-tab-panel">
          <p className="muted">
            Eén default Cursor Cloud-agent voor dit project. Nieuwe tickets op
            de eerste workflow-stage wekken deze agent. Alleen project-admin of
            platform-admin kan het id zetten of wissen.
          </p>
          <ProjectDefaultAgentPanel
            projectSlug={slug}
            legacy={identity.mode === "legacy"}
            canWrite={
              identity.is_platform_admin === true || membershipRole === "admin"
            }
          />
        </section>
      ) : activeTab === "agents" ? (
        <section className="settings-tab-panel">
          <p className="muted">
            Weergavenaam per Cursor Cloud-id voor dit project. Editor of
            project-admin kan opslaan; viewers zien de lijst alleen-lezen.
          </p>
          <ProjectAgentsPanel
            projectSlug={slug}
            legacy={identity.mode === "legacy"}
            canWrite={
              identity.is_platform_admin === true ||
              membershipRole === "admin" ||
              membershipRole === "editor"
            }
          />
        </section>
      ) : activeTab === "features" ? (
        <section className="settings-tab-panel">
          <p className="muted">
            Productfuncties voor dit project. Alleen project-admin of
            platform-admin kan opslaan; anderen zien de stand alleen-lezen.
          </p>
          <ProjectFeaturesPanel
            projectSlug={slug}
            legacy={identity.mode === "legacy"}
            canWrite={
              identity.is_platform_admin === true || membershipRole === "admin"
            }
          />
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
