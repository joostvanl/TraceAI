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
  description?: string | null;
  priority?: string | null;
  review_state?: string | null;
  review_by?: string | null;
  review_at?: string | null;
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

async function InboxTicketCard({
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
    return (
      <section className="panel inbox-ticket" id={item.slug}>
        <p className="form-error">Ticket {item.slug} niet gevonden.</p>
      </section>
    );
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
  const gatedChildCount = listDescendantSlugs(projectTickets, ticket.slug).filter(
    (childSlug) => {
      const child = bySlug.get(childSlug);
      if (!child) return false;
      return (
        stageByKey.get(child.fields.stage)?.agent
          ?.require_human_approval_on_exit === true
      );
    },
  ).length;

  return (
    <section className="panel inbox-ticket" id={ticket.slug}>
      <div className="panel-header">
        <div>
          <div className="meta-row">
            {ticket.fields.ticket_key ? (
              <span className="ticket-key ticket-key-lg">
                {ticket.fields.ticket_key}
              </span>
            ) : null}
            <span className="badge">
              {currentStage?.name ?? ticket.fields.stage}
            </span>
            <span className={`badge ${ticket.fields.priority ?? "medium"}`}>
              {ticket.fields.priority ?? "medium"}
            </span>
            <span className="badge">
              {item.awaiting === "verdict"
                ? "Wacht op jouw oordeel"
                : "Agent rondt af"}
            </span>
          </div>
          <h2 style={{ marginTop: "0.5rem" }}>{ticket.fields.title}</h2>
          <p className="muted" style={{ marginTop: "0.35rem" }}>
            Project{" "}
            <Link href={`/projects/${item.project}`}>{item.project}</Link>
            {" · "}
            <Link href={`/projects/${item.project}/tickets/${ticket.slug}`}>
              Open op board
            </Link>
          </p>
        </div>
      </div>

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

        {humanGated && item.awaiting === "verdict" ? (
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

        {humanGated && item.awaiting === "agent" && verdict ? (
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
    </section>
  );
}

export default async function InboxPage() {
  if (!(await isLoginConfigured())) redirect("/login");
  const identity = await getSessionIdentity();
  if (!identity) redirect("/login");

  const inbox = await loadInbox();

  return (
    <div className="inbox-page">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>Inbox</span>
      </nav>
      <div className="panel-header" style={{ marginBottom: "1rem" }}>
        <div>
          <h1>Review-inbox</h1>
          <p className="muted">
            Tickets die op jouw oordeel wachten — keuren kan hier direct, zonder
            naar het board te springen.
          </p>
        </div>
        {inbox.unread_count > 0 ? (
          <MarkNotificationsReadButton count={inbox.unread_count} />
        ) : null}
      </div>

      {inbox.error ? <p className="form-error">{inbox.error}</p> : null}

      <h2>Wacht op jouw oordeel ({inbox.awaiting_verdict.length})</h2>
      {inbox.awaiting_verdict.length === 0 ? (
        <p className="muted">Geen openstaande beoordelingen.</p>
      ) : (
        <div className="inbox-list">
          {inbox.awaiting_verdict.map((item) => (
            <InboxTicketCard
              key={item.slug}
              item={item}
              authenticated={Boolean(identity)}
            />
          ))}
        </div>
      )}

      <h2 style={{ marginTop: "2rem" }}>
        Agent rondt af ({inbox.awaiting_agent.length})
      </h2>
      {inbox.awaiting_agent.length === 0 ? (
        <p className="muted">Geen tickets die wachten op een agent-transitie.</p>
      ) : (
        <div className="inbox-list">
          {inbox.awaiting_agent.map((item) => (
            <InboxTicketCard
              key={item.slug}
              item={item}
              authenticated={Boolean(identity)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
