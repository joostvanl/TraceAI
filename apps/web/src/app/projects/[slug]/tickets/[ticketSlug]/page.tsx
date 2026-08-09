import Link from "next/link";
import { notFound } from "next/navigation";
import {
  computeTokenRollup,
  humanApproveTarget,
  humanRejectTargets,
  isTicketReviewState,
  listChildTickets,
  parseWorkflowDocument,
} from "@traceai/core";
import { HumanReviewActions } from "@/components/HumanReviewActions";
import { Markdown } from "@/components/Markdown";
import {
  getProject,
  getTicket,
  getWorkflow,
  listCommentsForTicket,
  listTicketsForProject,
} from "@/lib/cms";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; ticketSlug: string }>;
};

export default async function TicketPage({ params }: Props) {
  const { slug, ticketSlug } = await params;
  const [project, ticket, sessionUser, projectTickets] = await Promise.all([
    getProject(slug),
    getTicket(ticketSlug),
    getSessionUser(),
    listTicketsForProject(slug),
  ]);

  if (!project || !ticket || ticket.fields.project !== slug) {
    notFound();
  }

  const [comments, workflow] = await Promise.all([
    listCommentsForTicket(ticketSlug),
    getWorkflow(ticket.fields.workflow),
  ]);

  const stages = parseWorkflowDocument(workflow?.fields.stages_json).stages;
  const currentStage = stages.find((s) => s.key === ticket.fields.stage);
  const humanGated =
    currentStage?.agent?.require_human_approval_on_exit === true;
  const approveTo = currentStage ? humanApproveTarget(currentStage) : null;
  const rejectTo = currentStage ? humanRejectTargets(currentStage)[0] ?? null : null;
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
              gate={{ approveTo, rejectTo }}
              verdict={verdict}
            />
          ) : null}
        </section>
      </div>
    </>
  );
}
