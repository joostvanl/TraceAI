import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import {
  getProject,
  listWikiPagesForProject,
  resolveWikiPage,
  wikiHrefSlug,
} from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; pageSlug: string }>;
};

export default async function ProjectWikiPage({ params }: Props) {
  const { slug, pageSlug } = await params;
  await requireProjectAccess(slug);
  const [project, page] = await Promise.all([
    getProject(slug),
    resolveWikiPage(slug, pageSlug),
  ]);

  if (!project || !page) {
    notFound();
  }

  const { pages } = await listWikiPagesForProject(slug);
  const children = pages.filter((p) => p.fields.parent === page.slug);
  const parent = page.fields.parent
    ? pages.find((p) => p.slug === page.fields.parent)
    : null;

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <Link href={`/projects/${slug}/wiki`}>Wiki</Link>
        <span>/</span>
        <span>{page.fields.title}</span>
      </nav>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h1>{page.fields.title}</h1>
            <div className="meta-row" style={{ marginTop: "0.75rem" }}>
              {parent ? (
                <Link
                  className="muted"
                  href={`/projects/${slug}/wiki/${wikiHrefSlug(slug, parent.slug)}`}
                  style={{ fontSize: "0.85rem" }}
                >
                  Parent: {parent.fields.title}
                </Link>
              ) : (
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  Root page
                </span>
              )}
              {page.fields.updated_by ? (
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  by {page.fields.updated_by}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <Markdown content={page.fields.body ?? ""} />
      </section>

      {children.length > 0 ? (
        <section className="panel">
          <h2>Child pages</h2>
          <ul className="wiki-tree">
            {children.map((child) => (
              <li key={child.slug}>
                <Link
                  href={`/projects/${slug}/wiki/${wikiHrefSlug(slug, child.slug)}`}
                >
                  {child.fields.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
