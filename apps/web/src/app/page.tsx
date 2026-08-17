import Link from "next/link";
import { ConnectInstructions } from "@/components/ConnectInstructions";
import { getHomepageConnect, listProjects } from "@/lib/cms";
import { getSessionIdentity } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type ProjectCard = {
  slug: string;
  name: string;
  description: string;
};

async function loadMyProjects(): Promise<{
  projects: ProjectCard[];
  error: string | null;
}> {
  try {
    const identity = await getSessionIdentity();
    if (identity) {
      try {
        const client = createTraceServerClient({
          asHumanCapable: true,
          identity,
        });
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
        };
      } catch {
        // Fall through to Aurora public list when TraceAI proxy is unavailable.
      }
    }

    const aurora = await listProjects();
    return {
      projects: aurora.map((p) => ({
        slug: p.slug,
        name: p.fields.name,
        description: p.fields.description || "",
      })),
      error: null,
    };
  } catch (e) {
    return {
      projects: [],
      error: e instanceof Error ? e.message : "Failed to load projects",
    };
  }
}

export default async function HomePage() {
  const [{ projects, error }, connect] = await Promise.all([
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
          <div className="empty">Could not load projects: {error}</div>
        ) : projects.length === 0 ? (
          <div className="empty">
            No projects yet.{" "}
            <Link href="/projects/new">Create your first project</Link>.
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
