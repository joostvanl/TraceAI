import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateTicketForm } from "@/components/CreateTicketForm";
import { LiveBoard } from "@/components/LiveBoard";
import { getProjectBoard } from "@/lib/cms";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectPage({ params }: Props) {
  const { slug } = await params;
  const board = await getProjectBoard(slug);
  if (!board) notFound();

  const { project, stages, ticketsByStage } = board;
  const initialTickets = Object.values(ticketsByStage)
    .flat()
    .map((ticket) => ({
      slug: ticket.slug,
      ticketKey: ticket.fields.ticket_key ?? null,
      title: ticket.fields.title,
      stage: ticket.fields.stage,
      priority: ticket.fields.priority ?? "medium",
      stageChangedAt: ticket.updatedAt,
    }));

  const eventsUrl =
    process.env.NEXT_PUBLIC_TRACEAI_EVENTS_URL ??
    "http://127.0.0.1:3847/events";

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>{project.fields.name}</span>
      </nav>
      <h1>{project.fields.name}</h1>
      <p className="lede">{project.fields.description || "No description."}</p>

      {stages.length === 0 ? (
        <div className="empty">No workflow stages configured for this project.</div>
      ) : (
        <>
          <CreateTicketForm projectSlug={slug} />
          <LiveBoard
            projectSlug={slug}
            stages={stages.map((s) => ({ key: s.key, name: s.name }))}
            initialTickets={initialTickets}
            eventsUrl={eventsUrl}
          />
        </>
      )}
    </>
  );
}
