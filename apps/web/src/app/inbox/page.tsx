import Link from "next/link";
import { redirect } from "next/navigation";
import {
  humanApproveTarget,
  humanRejectTargets,
  isTicketReviewState,
  listDescendantSlugs,
  parseWorkflowDocument,
} from "@traceai/core";
import { HumanReviewActions } from "@/components/HumanReviewActions";
import {
  InboxAccordion,
  InboxAccordionItem,
} from "@/components/InboxAccordion";
import { Markdown } from "@/components/Markdown";
import { MarkNotificationsReadButton } from "@/components/MarkNotificationsReadButton";
import {
  getTicket,
  getWorkflow,
  listCommentsForTicket,
  listTicketsForProject,
} from "@/lib/cms";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

type InboxTicket = {
  slug: string;
  ticket_key: string | null;
  title: string;
  project: string;
  stage: string;
  stage_name: string;
  awaiting: "verdict" | "agent";
};

async function loadInbox(): Promise<{
  awaiting_verdict: InboxTicket[];
  awaiting_agent: InboxTicket[];
  unread_count: number;
  error: string | null;
}> {
  const identity = await getSessionIdentity();
  if (!identity) {
    return {
      awaiting_verdict: [],
      awaiting_agent: [],
      unread_count: 0,
      error: "Sign in required",
    };
  }
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const [inbox, notifications] = await Promise.all([
      client.listReviewInbox(),
      client.listNotifications({ unreadOnly: true }),
    ]);
    return {
      awaiting_verdict: inbox.awaiting_verdict as InboxTicket[],
      awaiting_agent: inbox.awaiting_agent as InboxTicket[],
      unread_count: notifications.unread_count,
      error: null,
    };
  } catch (error) {
    return {
      awaiting_verdict: [],
      awaiting_agent: [],
      unread_count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function InboxTicketBody({
  item,
  authenticated,
}: {
  item: InboxTicket;
  authenticated: boolean;
}) {
  const [ticket, comments, projectTickets] = await Promise.all([
    getTicket(item.slug),
    listCommentsForTicket(item.slug),
    listTicketsForProject(item.project),
  ]);
  if (!ticket) {
    return <p className="form-error">Ticket {item.slug} niet gevonden.</p>;
  }
  const workflow = await getWorkflow(ticket.fields.workflow);
  const stages = parseWorkflowDocument(workflow?.fields.stages_json).stages;
  const currentStage = stages.find((s) => s.key === ticket.fields.stage);
  const humanGated =
    currentStage?.agent?.require_human_approval_on_exit === true;
  const approveTo = currentStage ? humanApproveTarget(currentStage) : null;
  const rejectTo = currentStage
    ? (humanRejectTargets(currentStage)[0] ?? null)
    : null;
  const reviewState = ticket.fields.review_state;
  const verdict = isTicketReviewState(reviewState)
    ? {
        state: reviewState,
        by: ticket.fields.review_by ?? null,
        at: ticket.fields.review_at ?? null,
      }
    : null;
  const stageByKey = new Map(stages.map((s) => [s.key, s] as const));
  const bySlug = new Map(projectTickets.map((t) => [t.slug, t] as const));
  const gatedChildCount = listDescendantSlugs(
    projectTickets,
    ticket.slug,
  ).filter((childSlug) => {
    const child = bySlug.get(childSlug);
    if (!child) return false;
    return (
      stageByKey.get(child.fields.stage)?.agent
        ?.require_human_approval_on_exit === true
    );
  }).length;

  return (
    <>
      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        Project{" "}
        <Link href={`/projects/${item.project}`}>{item.project}</Link>
        {" · "}
        <Link href={`/projects/${item.project}/tickets/${ticket.slug}`}>
          Open op board
        </Link>
      </p>

      <Markdown content={ticket.fields.description ?? ""} />

      <div className="comments" style={{ marginTop: "1.25rem" }}>
        <h3>Comments</h3>
        {comments.length === 0 ? (
          <p className="muted">Nog geen comments.</p>
        ) : (
          comments.map((comment) => (
            <article key={comment.slug} className="comment">
              <div className="comment-meta">
                <strong>{comment.fields.author || "agent"}</strong>
                <time dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleString()}
                </time>
              </div>
              <Markdown content={comment.fields.body} />
            </article>
          ))
        )}

        {humanGated ? (
          <HumanReviewActions
            ticketSlug={ticket.slug}
            projectSlug={item.project}
            stageName={currentStage?.name ?? ticket.fields.stage}
            authenticated={authenticated}
            gate={{ approveTo, rejectTo }}
            verdict={verdict}
            gatedChildCount={gatedChildCount}
          />
        ) : null}
      </div>
    </>
  );
}

export default async function InboxPage() {
  if (!(await isLoginConfigured())) redirect("/login");
  const identity = await getSessionIdentity();
  if (!identity) redirect("/login");

  const inbox = await loadInbox();
  const waiting = inbox.awaiting_verdict.length;

  return (
    <div className="inbox-page">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>Inbox</span>
      </nav>
      <div className="panel-header" style={{ marginBottom: "1rem" }}>
        <div>
          <h1>
            Review-inbox
            {waiting > 0 ? (
              <span className="inbox-badge inbox-badge-lg" aria-label={`${waiting} wachtend`}>
                {waiting}
              </span>
            ) : null}
          </h1>
          <p className="muted">
            Klik een rij om het ticket te openen en te keuren. Er kan maar één
            ticket tegelijk openstaan.
          </p>
        </div>
        {inbox.unread_count > 0 ? (
          <MarkNotificationsReadButton count={inbox.unread_count} />
        ) : null}
      </div>

      {inbox.error ? <p className="form-error">{inbox.error}</p> : null}

      <h2>
        Wacht op jouw oordeel ({inbox.awaiting_verdict.length})
      </h2>
      {inbox.awaiting_verdict.length === 0 ? (
        <p className="muted">Geen openstaande beoordelingen.</p>
      ) : null}

      <h2 style={{ marginTop: "1.5rem" }}>
        Agent rondt af ({inbox.awaiting_agent.length})
      </h2>
      {inbox.awaiting_agent.length === 0 ? (
        <p className="muted">Geen tickets die wachten op een agent-transitie.</p>
      ) : null}

      {inbox.awaiting_verdict.length + inbox.awaiting_agent.length > 0 ? (
        <div style={{ marginTop: "1rem" }}>
          <InboxAccordion initialOpenId={null}>
            {[...inbox.awaiting_verdict, ...inbox.awaiting_agent].map((item) => (
              <InboxAccordionItem
                key={item.slug}
                id={item.slug}
                ticketKey={item.ticket_key}
                title={item.title}
                stageName={item.stage_name}
                project={item.project}
                awaiting={item.awaiting}
              >
                <InboxTicketBody
                  item={item}
                  authenticated={Boolean(identity)}
                />
              </InboxAccordionItem>
            ))}
          </InboxAccordion>
        </div>
      ) : null}
    </div>
  );
}
