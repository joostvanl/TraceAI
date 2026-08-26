import Link from "next/link";
import { notFound } from "next/navigation";
import { UNMAPPED_STAGE_KEY, relationSlug } from "@traceai/core";
import { CreateTicketForm } from "@/components/CreateTicketForm";
import { LiveBoard } from "@/components/LiveBoard";
import { getProjectBoard, listBoardTicketsViaTraceAI } from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ workflow?: string | string[] }>;
};

function firstQuery(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export default async function ProjectPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const requestedWorkflow = firstQuery((await searchParams).workflow);
  await requireProjectAccess(slug);
  const board = await getProjectBoard(slug, requestedWorkflow);
  if (!board) notFound();
  const sessionUser = await getSessionUser();

  const {
    project,
    stages,
    ticketsByStage,
    selectedWorkflow,
    defaultWorkflow,
    projectWorkflows,
  } = board;
  if (!selectedWorkflow) {
    return (
      <>
        <nav className="breadcrumb">
          <Link href="/">Projects</Link>
          <span>/</span>
          <span>{project.fields.name}</span>
        </nav>
        <h1>{project.fields.name}</h1>
        <div className="empty">No workflow stages configured for this project.</div>
      </>
    );
  }

  const lastStageKey = stages[stages.length - 1]?.key;
  const liveStageKeys = stages.map((s) => s.key);
  const ownedSlugs = projectWorkflows.map((w) => w.slug);

  const hasOverflow = Object.keys(ticketsByStage).some(
    (key) =>
      key === UNMAPPED_STAGE_KEY || !liveStageKeys.includes(key),
  );
  const boardStages = [
    ...stages.map((s) => ({
      key: s.key,
      name: s.name,
      requiresHumanApproval: s.agent?.require_human_approval_on_exit === true,
    })),
    ...(hasOverflow
      ? [{ key: UNMAPPED_STAGE_KEY, name: "Onbekende stage" }]
      : []),
  ];

  const initialTickets =
    (await listBoardTicketsViaTraceAI(slug, {
      selectedWorkflow,
      defaultWorkflow,
      projectWorkflowSlugs: ownedSlugs,
    })) ??
    Object.values(ticketsByStage)
      .flat()
      .map((ticket) => {
        const workflow = relationSlug(ticket.fields.workflow) ?? "";
        return {
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
          sortOrder: ticket.fields.sort_order ?? null,
          workflow,
          orphan: workflow !== selectedWorkflow,
          claimedAgentId: ticket.fields.claimed_agent_id?.trim() || null,
        };
      });

  const eventsUrl = "/api/events";

  const boardHref =
    defaultWorkflow && selectedWorkflow === defaultWorkflow
      ? `/projects/${slug}`
      : `/projects/${slug}?workflow=${encodeURIComponent(selectedWorkflow)}`;

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
            workflow={selectedWorkflow}
            boardHref={boardHref}
            authenticated={Boolean(sessionUser)}
          />
          <LiveBoard
            projectSlug={slug}
            selectedWorkflow={selectedWorkflow}
            defaultWorkflow={defaultWorkflow}
            projectWorkflowSlugs={ownedSlugs}
            stages={boardStages}
            lastStageKey={lastStageKey}
            initialTickets={initialTickets}
            eventsUrl={eventsUrl}
            canReorder={Boolean(sessionUser)}
          />
        </>
      )}
    </>
  );
}
