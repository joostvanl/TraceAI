import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountTokensPanel } from "@/components/AccountTokensPanel";
import { getProject } from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";
import { getSessionIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectTokensPage({ params }: Props) {
  const { slug } = await params;
  await requireProjectAccess(slug);
  const identity = await getSessionIdentity();
  if (!identity) notFound();
  const project = await getProject(slug);
  if (!project) notFound();

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>API-tokens</span>
      </nav>
      <p className="eyebrow">Account</p>
      <h1>API-tokens</h1>
      <p className="lede">
        Maak persoonlijke TraceAI-tokens (<code>trc_…</code>) voor agents en MCP.
        Alleen jij ziet en beheert je eigen tokens. Dit zijn account-tokens, geen
        project-tokens.
      </p>
      {identity.mode !== "personal" ? (
        <div className="empty">
          API-tokens werken alleen met een persoonlijk TraceAI-account. De
          gedeelde (legacy) login kan geen tokens aanmaken.
        </div>
      ) : (
        <AccountTokensPanel />
      )}
    </>
  );
}
