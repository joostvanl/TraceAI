import Link from "next/link";
import { getHomepageConnect, listProjects } from "@/lib/cms";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let error: string | null = null;
  const connect = await getHomepageConnect();

  try {
    projects = await listProjects();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load projects";
  }

  return (
    <>
      <section className="connect" aria-labelledby="connect-heading">
        <p className="eyebrow">{connect.eyebrow}</p>
        <h1 id="connect-heading">{connect.heading}</h1>
        <p className="lede">{connect.lede}</p>

        <ol className="steps">
          {connect.steps.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              <pre className="code-block">{step.body}</pre>
            </li>
          ))}
        </ol>

        {connect.mcpConfig ? (
          <pre className="code-block">{connect.mcpConfig}</pre>
        ) : null}

        <div className="connect-grid">
          <div className="panel connect-panel">
            <h2>MCP tools</h2>
            <ul className="tool-list">
              {connect.tools.map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
            {connect.toolsNote ? (
              <p className="muted note">{connect.toolsNote}</p>
            ) : null}
          </div>
          <div className="panel connect-panel">
            <h2>Rules</h2>
            <ul className="rules-list">
              {connect.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="projects-section" aria-labelledby="projects-heading">
        <h2 id="projects-heading">Projects</h2>
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
    </>
  );
}
