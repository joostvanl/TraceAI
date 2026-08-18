import Link from "next/link";
import { notFound } from "next/navigation";
import { WikiTreeNav } from "@/components/WikiTreeNav";
import { getProject, listWikiPagesForProject } from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectWikiIndexPage({ params }: Props) {
  const { slug } = await params;
  await requireProjectAccess(slug);
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
        The tree shows one level by default — use + / − to expand.
      </p>

      <section className="panel">
        <WikiTreeNav nodes={tree} projectSlug={slug} />
      </section>
    </>
  );
}
