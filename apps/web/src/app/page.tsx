import Link from "next/link";
import { ConnectInstructions } from "@/components/ConnectInstructions";
import { getHomepageConnect } from "@/lib/cms";
import { getSessionIdentity } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type ProjectCard = {
  slug: string;
  name: string;
  description: string;
};

/**
 * TRA-81: the TraceAI API is the only source for this list, because it is the
 * only one that knows the memberships. There is deliberately no Aurora fallback
 * any more — Aurora returns every project, so a failing API used to widen access
 * instead of narrowing it (F8). A failure is shown as a failure.
 */
async function loadMyProjects(): Promise<{
  projects: ProjectCard[];
  error: string | null;
  signedIn: boolean;
}> {
  const identity = await getSessionIdentity();
  if (!identity) {
    return { projects: [], error: null, signedIn: false };
  }
  try {
    const client = createTraceServerClient({ asHumanCapable: true, identity });
    const rows = (await client.listMyProjects()) as Array<{
      slug: string;
      name?: string;
      description?: string | null;
    }>;
    return {
      projects: rows.map((p) => ({
        slug: p.slug,
        name: p.name ?? p.slug,
        description: p.description ?? "",
      })),
      error: null,
      signedIn: true,
    };
  } catch (e) {
    return {
      projects: [],
      error: e instanceof Error ? e.message : "Failed to load projects",
      signedIn: true,
    };
  }
}

export default async function HomePage() {
  const [{ projects, error, signedIn }, connect] = await Promise.all([
    loadMyProjects(),
    getHomepageConnect(),
  ]);

  return (
    <>
      <section className="projects-section" aria-labelledby="projects-heading">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <h1 id="projects-heading">Projects</h1>
          <Link href="/projects/new" className="btn primary">
            New project
          </Link>
        </div>
        <p className="lede">
          Overview of work prepared and tracked by AI agents. Open a project to
          follow the live board or add a wish to the backlog.
        </p>

        {error ? (
          <div className="empty">
            Could not load your projects: {error}. This list comes from the
            TraceAI API; it is not filled from another source, so nothing is
            shown rather than too much.
          </div>
        ) : !signedIn ? (
          <div className="empty">
            <Link href="/login">Sign in</Link> to see the projects you are a
            member of.
          </div>
        ) : projects.length === 0 ? (
          <div className="empty">
            You are not a member of any project yet. Ask an admin for access, or{" "}
            <Link href="/projects/new">create your own project</Link>.
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((project) => (
              <Link
                key={project.slug}
                href={`/projects/${project.slug}`}
                className="project-card"
              >
                <h2>{project.name}</h2>
                <p>{project.description || "No description."}</p>
              </Link>
            ))}
          </div>
        )}
      </section>
      <ConnectInstructions connect={connect} headingLevel="h2" />
    </>
  );
}
