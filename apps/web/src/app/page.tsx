import Link from "next/link";
import { listProjects } from "@/lib/cms";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let error: string | null = null;

  try {
    projects = await listProjects();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load projects";
  }

  return (
    <section className="projects-section" aria-labelledby="projects-heading">
      <h1 id="projects-heading">Projects</h1>
      <p className="lede">
        Overview of work prepared and tracked by AI agents. Open a project to
        follow the live board or add a wish to the backlog.
      </p>

      {error ? (
        <div className="empty">Could not load projects: {error}</div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects published yet.</div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <Link
              key={project.slug}
              href={`/projects/${project.slug}`}
              className="project-card"
            >
              <h2>{project.fields.name}</h2>
              <p>{project.fields.description || "No description."}</p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
