import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import {
  getProject,
  getTicket,
  listCommentsForTicket,
} from "@/lib/cms";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; ticketSlug: string }>;
};

export default async function TicketPage({ params }: Props) {
  const { slug, ticketSlug } = await params;
  const [project, ticket] = await Promise.all([
    getProject(slug),
    getTicket(ticketSlug),
  ]);

  if (!project || !ticket || ticket.fields.project !== slug) {
    notFound();
  }

  const comments = await listCommentsForTicket(ticketSlug);

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
                <span className="badge">{ticket.fields.stage}</span>
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
        </section>
      </div>
    </>
  );
}
