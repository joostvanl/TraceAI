import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import {
  computeTokenRollup,
  firstStageKey,
  humanApproveTarget,
  humanDismissTarget,
  humanRejectTargets,
  isTicketReviewState,
  isTicketWorkflowReassignable,
  listChildTickets,
  listDescendantSlugs,
  parseWorkflowDocument,
  relationSlug,
  resolveTicketRef,
} from "@traceai/core";
import { HumanReviewActions } from "@/components/HumanReviewActions";
import { Markdown } from "@/components/Markdown";
import { TicketWorkflowSelect } from "@/components/TicketWorkflowSelect";
import {
  getProject,
  getTicket,
  getWorkflow,
  listCommentsForTicket,
  listTicketsForProject,
  listWorkflowsForProject,
} from "@/lib/cms";
import { sortWorkflowsForNav } from "@/lib/project-nav";
import { requireProjectAccess } from "@/lib/project-access";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; ticketSlug: string }>;
};

export default async function TicketPage({ params }: Props) {
  const { slug, ticketSlug } = await params;
  await requireProjectAccess(slug);
  const [project, sessionUser, projectTickets] = await Promise.all([
    getProject(slug),
    getSessionUser(),
    listTicketsForProject(slug),
  ]);

  if (!project) {
    notFound();
  }

  const resolved = resolveTicketRef(projectTickets, ticketSlug);
  let ticket = resolved
    ? (projectTickets.find((t) => t.slug === resolved.slug) ?? null)
    : null;

  if (!ticket) {
    const byRef = await getTicket(ticketSlug);
    if (byRef && byRef.fields.project === slug) {
      ticket = byRef;
    }
  }

  if (!ticket) {
    notFound();
  }

  if (ticketSlug !== ticket.slug) {
    permanentRedirect(`/projects/${slug}/tickets/${ticket.slug}`);
  }

  const [comments, workflow, projectWorkflows] = await Promise.all([
    listCommentsForTicket(ticket.slug),
    getWorkflow(ticket.fields.workflow),
    listWorkflowsForProject(slug),
  ]);

  const stages = parseWorkflowDocument(workflow?.fields.stages_json).stages;
  const defaultWorkflow = relationSlug(project.fields.default_workflow);
  const canChangeWorkflow =
    Boolean(sessionUser) &&
    isTicketWorkflowReassignable({
      currentPin: ticket.fields.workflow,
      currentStage: ticket.fields.stage,
      liveFirstStageKey: workflow ? firstStageKey(stages) : null,
      defaultWorkflow,
      projectWorkflowSlugs: projectWorkflows.map((w) => w.slug),
    });
  const workflowOptions = sortWorkflowsForNav(
    projectWorkflows.map((w) => ({
      slug: w.slug,
      name: w.fields.name || w.slug,
    })),
    defaultWorkflow,
  ).map((w) => ({
    ...w,
    isDefault: Boolean(defaultWorkflow && w.slug === defaultWorkflow),
  }));
  const currentStage = stages.find((s) => s.key === ticket.fields.stage);
  const humanGated =
    currentStage?.agent?.require_human_approval_on_exit === true;
  const approveTo = currentStage ? humanApproveTarget(currentStage) : null;
  const rejectTo = currentStage ? humanRejectTargets(currentStage)[0] ?? null : null;
  const dismissTo = currentStage ? humanDismissTarget(currentStage) : null;
  const reviewState = ticket.fields.review_state;
  const verdict = isTicketReviewState(reviewState)
    ? {
        state: reviewState,
        by: ticket.fields.review_by ?? null,
        at: ticket.fields.review_at ?? null,
      }
    : null;

  const parentSlug = ticket.fields.parent || null;
  const parentTicket = parentSlug
    ? (projectTickets.find((t) => t.slug === parentSlug) ?? null)
    : null;
  const childSlugs = new Set(
    listChildTickets(projectTickets, ticket.slug).map((c) => c.slug),
  );
  const children = projectTickets.filter((t) => childSlugs.has(t.slug));
  const rollup = computeTokenRollup(projectTickets, ticket.slug);
  const ownEstimate =
    typeof ticket.fields.tokens_estimate === "number"
      ? ticket.fields.tokens_estimate
      : null;
  const ownActual =
    typeof ticket.fields.tokens_actual === "number"
      ? ticket.fields.tokens_actual
      : null;
  const showRollup =
    children.length > 0 ||
    rollup.tokens_estimate_rollup !== (ownEstimate ?? 0) ||
    rollup.tokens_actual_rollup !== (ownActual ?? 0);

  const descendantSlugs = listDescendantSlugs(projectTickets, ticket.slug);
  const bySlug = new Map(projectTickets.map((t) => [t.slug, t] as const));
  const stageByKey = new Map(stages.map((s) => [s.key, s] as const));
  const gatedChildCount = descendantSlugs.filter((childSlug) => {
    const child = bySlug.get(childSlug);
    if (!child) return false;
    const childStage = stageByKey.get(child.fields.stage);
    return childStage?.agent?.require_human_approval_on_exit === true;
  }).length;

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>{ticket.fields.title}</span>
      </nav>

      <div className="ticket-detail">
        <section className="panel">
          <div className="panel-header">
            <div>
              {ticket.fields.ticket_key ? (
                <div className="ticket-key ticket-key-lg">
                  {ticket.fields.ticket_key}
                </div>
              ) : null}
              <h1>{ticket.fields.title}</h1>
              <div className="meta-row" style={{ marginTop: "0.75rem" }}>
                <span className="badge">
                  {currentStage?.name ?? ticket.fields.stage}
                </span>
                <TicketWorkflowSelect
                  ticketSlug={ticket.slug}
                  currentSlug={ticket.fields.workflow || ""}
                  currentLabel={
                    workflow?.fields.name ||
                    ticket.fields.workflow ||
                    "onbekend"
                  }
                  options={workflowOptions}
                  canChange={canChangeWorkflow}
                  disabledReason="Workflow kan alleen in de eerste stage worden gewijzigd"
                />
                <span
                  className={`badge ${ticket.fields.priority ?? "medium"}`}
                >
                  {ticket.fields.priority ?? "medium"}
                </span>
                {ticket.fields.created_by ? (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    by {ticket.fields.created_by}
                  </span>
                ) : null}
                {ticket.fields.resolution ? (
                  <span className="badge">{ticket.fields.resolution}</span>
                ) : null}
                {ownEstimate != null || ownActual != null || showRollup ? (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    tokens{" "}
                    {ownEstimate != null
                      ? `~${ownEstimate.toLocaleString()}`
                      : "—"}
                    {" / "}
                    {ownActual != null ? ownActual.toLocaleString() : "—"}
                    {showRollup ? (
                      <>
                        {" · roll-up ~"}
                        {rollup.tokens_estimate_rollup.toLocaleString()}
                        {" / "}
                        {rollup.tokens_actual_rollup.toLocaleString()}
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {parentTicket ? (
                <p className="muted" style={{ marginTop: "0.75rem" }}>
                  Parent:{" "}
                  <Link
                    href={`/projects/${slug}/tickets/${parentTicket.slug}`}
                  >
                    {parentTicket.fields.ticket_key ?? parentTicket.slug}
                  </Link>
                  {" — "}
                  {parentTicket.fields.title}
                </p>
              ) : null}
            </div>
          </div>
          <Markdown content={ticket.fields.description ?? ""} />
        </section>

        {children.length > 0 ? (
          <section className="panel">
            <h2>Subtickets</h2>
            <ul className="ticket-children">
              {children.map((child) => {
                const childStage = stages.find(
                  (s) => s.key === child.fields.stage,
                );
                return (
                  <li key={child.slug}>
                    <Link href={`/projects/${slug}/tickets/${child.slug}`}>
                      <span className="ticket-key">
                        {child.fields.ticket_key ?? child.slug}
                      </span>{" "}
                      {child.fields.title}
                    </Link>
                    <span className="muted" style={{ marginLeft: "0.5rem" }}>
                      {childStage?.name ?? child.fields.stage}
                      {typeof child.fields.tokens_estimate === "number"
                        ? ` · ~${child.fields.tokens_estimate.toLocaleString()}`
                        : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="panel">
          <h2>Comments</h2>
          {comments.length === 0 ? (
            <p className="muted">No comments yet.</p>
          ) : (
            <div className="comments">
              {comments.map((comment) => (
                <article key={comment.slug} className="comment">
                  <div className="comment-meta">
                    <strong>{comment.fields.author || "agent"}</strong>
                    <time dateTime={comment.createdAt}>
                      {new Date(comment.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <Markdown content={comment.fields.body} />
                </article>
              ))}
            </div>
          )}

          {humanGated ? (
            <HumanReviewActions
              ticketSlug={ticket.slug}
              projectSlug={slug}
              stageName={currentStage?.name ?? ticket.fields.stage}
              authenticated={Boolean(sessionUser)}
              gate={{ approveTo, rejectTo, dismissTo }}
              verdict={verdict}
              gatedChildCount={gatedChildCount}
            />
          ) : null}
        </section>
      </div>
    </>
  );
}
