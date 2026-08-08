import Link from "next/link";
import { notFound } from "next/navigation";
import {
  humanApproveTarget,
  humanRejectTargets,
  parseWorkflowDocument,
} from "@traceai/core";
import { HumanReviewActions } from "@/components/HumanReviewActions";
import { Markdown } from "@/components/Markdown";
import {
  getProject,
  getTicket,
  getWorkflow,
  listCommentsForTicket,
} from "@/lib/cms";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; ticketSlug: string }>;
};

export default async function TicketPage({ params }: Props) {
  const { slug, ticketSlug } = await params;
  const [project, ticket, sessionUser] = await Promise.all([
    getProject(slug),
    getTicket(ticketSlug),
    getSessionUser(),
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
  const rejectTo = currentStage ? humanRejectTargets(currentStage) : [];
  const targetApprove = approveTo
    ? stages.find((s) => s.key === approveTo)
    : null;

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
                {typeof ticket.fields.tokens_estimate === "number" ||
                typeof ticket.fields.tokens_actual === "number" ? (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    tokens{" "}
                    {typeof ticket.fields.tokens_estimate === "number"
                      ? `~${ticket.fields.tokens_estimate.toLocaleString()}`
                      : "—"}
                    {" / "}
                    {typeof ticket.fields.tokens_actual === "number"
                      ? ticket.fields.tokens_actual.toLocaleString()
                      : "—"}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <Markdown content={ticket.fields.description ?? ""} />
        </section>

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
              gate={{
                approveTo,
                rejectTo,
                requireResolution:
                  targetApprove?.agent?.require_resolution_on_enter === true,
                requireWiki: Boolean(
                  targetApprove?.agent?.require_comment_sections_on_enter?.some(
                    (s) => s.toLowerCase().includes("wiki"),
                  ),
                ),
              }}
            />
          ) : null}
        </section>
      </div>
    </>
  );
}
