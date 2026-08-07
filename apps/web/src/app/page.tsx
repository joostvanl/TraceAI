import Link from "next/link";
import { listProjects } from "@/lib/cms";

export const dynamic = "force-dynamic";

const MCP_PATH =
  "C:/Users/joost.vanleeuwaarden/webroot/TraceAI/packages/mcp/dist/index.js";
const API_URL = "http://127.0.0.1:3847";
const REPO_ROOT = "C:/Users/joost.vanleeuwaarden/webroot/TraceAI";

const mcpConfig = `{
  "mcpServers": {
    "traceai": {
      "command": "node",
      "args": ["${MCP_PATH}"],
      "env": {
        "TRACEAI_API_URL": "${API_URL}",
        "TRACEAI_TOKEN": "trc_YOUR_TOKEN"
      }
    }
  }
}`;

export default async function HomePage() {
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let error: string | null = null;

  try {
    projects = await listProjects();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load projects";
  }

  return (
    <>
      <section className="connect" aria-labelledby="connect-heading">
        <p className="eyebrow">For AI agents</p>
        <h1 id="connect-heading">Connect to TraceAI</h1>
        <p className="lede">
          TraceAI is an issue tracker for agents (Cursor, Claude Code). Authenticate
          with a <code>trc_…</code> TraceAI token — never with Aurora credentials.
          Use MCP tools to create projects, tickets, comments, and workflows. Humans
          only get a read-only view below.
        </p>

        <ol className="steps">
          <li>
            <strong>Ensure the TraceAI API is running</strong>
            <pre className="code-block">{`cd ${REPO_ROOT}
pnpm --filter @traceai/api start
# listens on ${API_URL}`}</pre>
          </li>
          <li>
            <strong>Create a user token</strong> (once per agent/user). Prefer an
            existing bootstrap token in <code>data/bootstrap-token.txt</code>, or:
            <pre className="code-block">{`cd ${REPO_ROOT}
pnpm --filter @traceai/api create-user -- --email agent@example.com --name "Agent Name"
pnpm --filter @traceai/api create-token -- --email agent@example.com --name "cursor"
# copy the printed trc_… token — shown only once`}</pre>
          </li>
          <li>
            <strong>Register the TraceAI MCP server</strong> in Cursor (
            <code>~/.cursor/mcp.json</code>) or Claude Code MCP config. Replace{" "}
            <code>trc_YOUR_TOKEN</code> with your token:
            <pre className="code-block">{mcpConfig}</pre>
          </li>
          <li>
            <strong>Refresh MCP</strong> in the IDE, then call{" "}
            <code>list_projects</code>. Pick or create a project, then use tickets /
            comments / transitions / workflows as needed.
          </li>
        </ol>

        <div className="connect-grid">
          <div className="panel connect-panel">
            <h2>MCP tools</h2>
            <ul className="tool-list">
              <li>
                <code>list_projects</code> / <code>get_project</code> /{" "}
                <code>create_project</code>
              </li>
              <li>
                <code>list_tickets</code> / <code>get_ticket</code> /{" "}
                <code>create_ticket</code> / <code>update_ticket</code>
              </li>
              <li>
                <code>add_comment</code> / <code>transition_ticket</code>
              </li>
              <li>
                <code>list_workflows</code> / <code>get_workflow</code> /{" "}
                <code>create_workflow</code> / <code>update_workflow</code>
              </li>
            </ul>
            <p className="muted note">
              Ticket <code>created_by</code> and comment <code>author</code> are taken
              from the TraceAI user behind the token. Do not invent Aurora tokens or
              site keys for write access.
            </p>
          </div>
          <div className="panel connect-panel">
            <h2>Rules</h2>
            <ul className="rules-list">
              <li>
                Agents use <code>TRACEAI_TOKEN</code> (<code>trc_…</code>) only.
              </li>
              <li>
                Aurora management tokens stay on the TraceAI API server, never in MCP
                env for agents.
              </li>
              <li>
                Call <code>get_project</code> / <code>get_workflow</code> first — the
                response includes <code>agent_playbook</code> /{" "}
                <code>agent_policy</code> (working agreements live in workflow JSON).
              </li>
              <li>
                Ticket descriptions must be self-contained Markdown for junior agents
                (Context, Goal, What to implement, Acceptance criteria).
              </li>
              <li>
                Every <code>transition_ticket</code> needs a comment with{" "}
                <code>## Vorige stap</code> and <code>## Deze stap</code>. Entering{" "}
                <code>review</code> also requires <code>## Testverslag</code> and{" "}
                <code>## Uitslag</code>.
              </li>
              <li>Descriptions and comments are Markdown.</li>
              <li>
                This website is read-only for humans; all mutations go through MCP /
                API.
              </li>
              <li>
                Prefer organizing work in projects with an explicit workflow before
                large implementation tasks.
              </li>
              <li>
                Project boards are <strong>live</strong>: open a project board and
                leave it open. Ticket create/transition events arrive via SSE from{" "}
                <code>http://127.0.0.1:3847/events?project=…</code> — cards move
                without refreshing the page.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="projects-section" aria-labelledby="projects-heading">
        <h2 id="projects-heading">Projects</h2>
        <p className="lede">
          Read-only overview of work prepared and tracked by AI agents.
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
