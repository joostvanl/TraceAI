import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getProject,
  listWikiPagesForProject,
  type WikiTreeNode,
} from "@/lib/cms";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

function WikiTree({
  nodes,
  projectSlug,
}: {
  nodes: WikiTreeNode[];
  projectSlug: string;
}) {
  if (nodes.length === 0) {
    return <p className="muted">No wiki pages yet.</p>;
  }
  return (
    <ul className="wiki-tree">
      {nodes.map((node) => (
        <li key={node.slug}>
          <Link href={`/projects/${projectSlug}/wiki/${node.slug}`}>
            {node.title}
          </Link>
          {node.children.length > 0 ? (
            <WikiTree nodes={node.children} projectSlug={projectSlug} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default async function ProjectWikiIndexPage({ params }: Props) {
  const { slug } = await params;
  const project = await getProject(slug);
  if (!project) notFound();

  const { tree } = await listWikiPagesForProject(slug);

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>Wiki</span>
      </nav>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1>Wiki</h1>
        <Link className="muted" href={`/projects/${slug}`}>
          ← Board
        </Link>
      </div>
      <p className="lede">
        Project documentation (read-only). Agents update pages via TraceAI MCP.
      </p>

      <section className="panel">
        <WikiTree nodes={tree} projectSlug={slug} />
      </section>
    </>
  );
}
