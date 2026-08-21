import Link from "next/link";
import { notFound } from "next/navigation";
import {
  TICKET_RESOLUTIONS,
  parseWorkflowDocument,
} from "@traceai/core";
import {
  getProject,
  listProjectTicketsPublic,
  listWorkflowsForProject,
} from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";
import {
  TICKET_LIST_PRIORITIES,
  TICKETS_PAGE_SIZE,
  formatEntered,
  formatTokens,
  parseTicketListQuery,
  ticketListHref,
  uniqueStageKeys,
} from "@/lib/project-tickets";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProjectTicketsPage({
  params,
  searchParams,
}: Props) {
  const { slug } = await params;
  await requireProjectAccess(slug);
  const [project, workflows] = await Promise.all([
    getProject(slug),
    listWorkflowsForProject(slug),
  ]);
  if (!project) notFound();

  const query = parseTicketListQuery(await searchParams);
  const page = await listProjectTicketsPublic(slug, query);
  const workflowName = new Map(
    workflows.map((workflow) => [workflow.slug, workflow.fields.name]),
  );
  const stages = uniqueStageKeys(
    workflows.flatMap((workflow) =>
      parseWorkflowDocument(workflow.fields.stages_json).stages.map(
        (stage) => stage.key,
      ),
    ),
  );

  const hasPrev = query.offset > 0;
  const nextOffset = query.offset + TICKETS_PAGE_SIZE;
  const hasNext = nextOffset < page.total;
  const prevOffset = Math.max(0, query.offset - TICKETS_PAGE_SIZE);

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>Tickets</span>
      </nav>

      <h1>Tickets</h1>
      <p className="lede">
        All tickets in this project, across every workflow and stage. Search and
        filters live in the URL.
      </p>

      <section className="panel insights-section">
        <div className="panel-header">
          <h2>Filter</h2>
          <span className="muted">
            {page.total} ticket{page.total === 1 ? "" : "s"}
          </span>
        </div>
        <form className="insights-search-form" method="get">
          <label>
            Query
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              placeholder="Key, title, description, comment…"
            />
          </label>
          <label>
            Workflow
            <select name="workflow" defaultValue={query.workflow}>
              <option value="">Any</option>
              {workflows.map((workflow) => (
                <option key={workflow.slug} value={workflow.slug}>
                  {workflow.fields.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stage
            <select name="stage" defaultValue={query.stage}>
              <option value="">Any</option>
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select name="priority" defaultValue={query.priority}>
              <option value="">Any</option>
              {TICKET_LIST_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>
          <label>
            Resolution
            <select name="resolution" defaultValue={query.resolution}>
              <option value="">Any</option>
              {TICKET_RESOLUTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>

        {page.items.length === 0 ? (
          <p className="empty">No tickets match these filters.</p>
        ) : (
          <div className="insights-table-wrap">
            <table className="insights-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Title</th>
                  <th>Workflow</th>
                  <th>Stage</th>
                  <th>Priority</th>
                  <th>Tokens</th>
                  <th>Entered</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((ticket) => (
                  <tr key={ticket.slug}>
                    <td className="mono">
                      <Link href={`/projects/${slug}/tickets/${ticket.slug}`}>
                        {ticket.ticket_key ?? ticket.slug}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/projects/${slug}/tickets/${ticket.slug}`}>
                        {ticket.title}
                      </Link>
                    </td>
                    <td>
                      {workflowName.get(ticket.workflow) ?? ticket.workflow}
                    </td>
                    <td>{ticket.stage}</td>
                    <td>{ticket.priority}</td>
                    <td className="mono">
                      {formatTokens(
                        ticket.tokens_estimate,
                        ticket.tokens_actual,
                      )}
                    </td>
                    <td className="mono muted">
                      {formatEntered(ticket.stage_entered_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="insights-pager">
          {hasPrev ? (
            <Link href={ticketListHref(slug, query, prevOffset)}>← Prev</Link>
          ) : (
            <span className="muted">← Prev</span>
          )}
          <span className="muted">
            {page.total === 0
              ? "0"
              : `${query.offset + 1}–${Math.min(query.offset + page.items.length, page.total)} of ${page.total}`}
          </span>
          {hasNext ? (
            <Link href={ticketListHref(slug, query, nextOffset)}>Next →</Link>
          ) : (
            <span className="muted">Next →</span>
          )}
        </div>
      </section>
    </>
  );
}
