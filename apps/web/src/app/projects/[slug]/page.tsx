import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateTicketForm } from "@/components/CreateTicketForm";
import { LiveBoard } from "@/components/LiveBoard";
import { getProjectBoard } from "@/lib/cms";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectPage({ params }: Props) {
  const { slug } = await params;
  const board = await getProjectBoard(slug);
  if (!board) notFound();
  const sessionUser = await getSessionUser();

  const { project, stages, ticketsByStage } = board;
  const lastStageKey = stages[stages.length - 1]?.key;
  const initialTickets = Object.values(ticketsByStage)
    .flat()
    .map((ticket) => ({
      slug: ticket.slug,
      ticketKey: ticket.fields.ticket_key ?? null,
      title: ticket.fields.title,
      stage: ticket.fields.stage,
      priority: ticket.fields.priority ?? "medium",
      stageChangedAt:
        ticket.fields.stage_entered_at ?? ticket.updatedAt,
    }));

  const eventsUrl =
    process.env.NEXT_PUBLIC_TRACEAI_EVENTS_URL ??
    "https://traceai.joostvanleeuwaarden.com/events";

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
          <CreateTicketForm
            projectSlug={slug}
            authenticated={Boolean(sessionUser)}
          />
          <LiveBoard
            projectSlug={slug}
            stages={stages.map((s) => ({ key: s.key, name: s.name }))}
            lastStageKey={lastStageKey}
            initialTickets={initialTickets}
            eventsUrl={eventsUrl}
          />
        </>
      )}
    </>
  );
}
