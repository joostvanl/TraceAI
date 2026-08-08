import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateTicketForm } from "@/components/CreateTicketForm";
import { LiveBoard } from "@/components/LiveBoard";
import { getProjectBoard, listBoardTicketsViaTraceAI } from "@/lib/cms";
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
  // Prefer the TraceAI API (single source of truth, matches the SSE stream)
  // for the live board's initial tickets; fall back to the Aurora-derived
  // board when TraceAI isn't configured on the web server.
  const initialTickets =
    (await listBoardTicketsViaTraceAI(slug)) ??
    Object.values(ticketsByStage)
      .flat()
      .map((ticket) => ({
        slug: ticket.slug,
        ticketKey: ticket.fields.ticket_key ?? null,
        title: ticket.fields.title,
        stage: ticket.fields.stage,
        priority: ticket.fields.priority ?? "medium",
        stageChangedAt: ticket.fields.stage_entered_at ?? ticket.updatedAt,
        tokensEstimate: ticket.fields.tokens_estimate ?? null,
        tokensActual: ticket.fields.tokens_actual ?? null,
        resolution: ticket.fields.resolution ?? null,
        reviewState: ticket.fields.review_state || null,
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1>{project.fields.name}</h1>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <Link href={`/projects/${slug}/insights`}>Insights</Link>
          <Link href={`/projects/${slug}/wiki`}>Wiki</Link>
        </div>
      </div>
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
            stages={stages.map((s) => ({
              key: s.key,
              name: s.name,
              requiresHumanApproval:
                s.agent?.require_human_approval_on_exit === true,
            }))}
            lastStageKey={lastStageKey}
            initialTickets={initialTickets}
            eventsUrl={eventsUrl}
          />
        </>
      )}
    </>
  );
}
