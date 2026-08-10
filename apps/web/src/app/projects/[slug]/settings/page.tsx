import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProjectMembersPanel } from "@/components/ProjectMembersPanel";
import { getProject } from "@/lib/cms";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { slug } = await params;
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
      <p className="muted">Leden en rollen (admin / editor / viewer).</p>
      {loadError ? <p className="form-error">{loadError}</p> : null}
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
    </div>
  );
}
