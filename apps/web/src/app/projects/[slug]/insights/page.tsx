import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getProject,
  getProjectInsightsPublic,
  listProjectHistoryPublic,
  searchProjectPublic,
} from "@/lib/cms";
import { requireProjectAccess } from "@/lib/project-access";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function one(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function formatAge(days: number | null): string {
  if (days == null) return "—";
  if (days < 1) return "<1d";
  return `${days.toFixed(1)}d`;
}

export default async function ProjectInsightsPage({
  params,
  searchParams,
}: Props) {
  const { slug } = await params;
  await requireProjectAccess(slug);
  const sp = await searchParams;
  const project = await getProject(slug);
  if (!project) notFound();

  const q = one(sp.q)?.trim() ?? "";
  const typeRaw = one(sp.type) ?? "all";
  const type =
    typeRaw === "ticket" || typeRaw === "wiki_page" || typeRaw === "all"
      ? typeRaw
      : "all";
  const stage = one(sp.stage)?.trim() || undefined;
  const resolution = one(sp.resolution)?.trim() || undefined;
  const priority = one(sp.priority)?.trim() || undefined;
  const created_by = one(sp.created_by)?.trim() || undefined;
  const historyStage = one(sp.history_stage)?.trim() || "done";
  const historyOffset = Math.max(0, Number(one(sp.history_offset) ?? 0) || 0);
  const historyLimit = 20;

  const [search, history, insightsBundle] = await Promise.all([
    searchProjectPublic(slug, {
      q: q || undefined,
      type,
      stage,
      resolution,
      priority,
      created_by,
      limit: 30,
      offset: 0,
    }),
    listProjectHistoryPublic(slug, {
      stage: historyStage || undefined,
      limit: historyLimit,
      offset: historyOffset,
    }),
    getProjectInsightsPublic(slug),
  ]);

  const insights = insightsBundle?.insights;
  const historyPrev = Math.max(0, historyOffset - historyLimit);
  const historyNext = historyOffset + historyLimit;
  const hasPrev = historyOffset > 0;
  const hasNext = historyNext < history.total;

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${slug}`}>{project.fields.name}</Link>
        <span>/</span>
        <span>Insights</span>
      </nav>

      <h1>Insights &amp; search</h1>
      <p className="lede">
        Search tickets and wiki, browse full Done history (beyond the board
        window), and view basic delivery metrics. Read-only.
      </p>

      <section className="panel insights-section">
        <div className="panel-header">
          <h2>Search</h2>
        </div>
        <form className="insights-search-form" method="get">
          <label>
            Query
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Key, title, description, comment, wiki…"
            />
          </label>
          <label>
            Type
            <select name="type" defaultValue={type}>
              <option value="all">All</option>
              <option value="ticket">Tickets</option>
              <option value="wiki_page">Wiki</option>
            </select>
          </label>
          <label>
            Stage
            <input name="stage" defaultValue={stage ?? ""} placeholder="done" />
          </label>
          <label>
            Resolution
            <input
              name="resolution"
              defaultValue={resolution ?? ""}
              placeholder="completed"
            />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue={priority ?? ""}>
              <option value="">Any</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            Actor
            <input
              name="created_by"
              defaultValue={created_by ?? ""}
              placeholder="created_by / author"
            />
          </label>
          <input type="hidden" name="history_stage" value={historyStage} />
          <input type="hidden" name="history_offset" value={String(historyOffset)} />
          <button type="submit">Search</button>
        </form>

        {search.total === 0 ? (
          <p className="empty">No matches. Try a broader query or clear filters.</p>
        ) : (
          <ul className="insights-results">
            {search.items.map((hit) => (
              <li key={`${hit.type}:${hit.slug}`}>
                <span className="insights-type">{hit.type}</span>
                {hit.type === "ticket" ? (
                  <Link href={`/projects/${slug}/tickets/${hit.slug}`}>
                    {hit.ticket_key ? `${hit.ticket_key} · ` : ""}
                    {hit.title}
                  </Link>
                ) : (
                  <Link href={`/projects/${slug}/wiki/${hit.slug}`}>
                    {hit.title}
                  </Link>
                )}
                {hit.snippet ? (
                  <p className="muted insights-snippet">{hit.snippet}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel insights-section">
        <div className="panel-header">
          <h2>History</h2>
          <span className="muted">
            {history.total} ticket{history.total === 1 ? "" : "s"}
            {historyStage ? ` · stage=${historyStage}` : ""}
          </span>
        </div>
        <form className="insights-search-form" method="get">
          <input type="hidden" name="q" value={q} />
          <input type="hidden" name="type" value={type} />
          {stage ? <input type="hidden" name="stage" value={stage} /> : null}
          {resolution ? (
            <input type="hidden" name="resolution" value={resolution} />
          ) : null}
          {priority ? (
            <input type="hidden" name="priority" value={priority} />
          ) : null}
          {created_by ? (
            <input type="hidden" name="created_by" value={created_by} />
          ) : null}
          <label>
            Stage
            <input
              name="history_stage"
              defaultValue={historyStage}
              placeholder="done"
            />
          </label>
          <input type="hidden" name="history_offset" value="0" />
          <button type="submit">Load</button>
        </form>

        {history.items.length === 0 ? (
          <p className="empty">No tickets in this history window.</p>
        ) : (
          <div className="insights-table-wrap">
            <table className="insights-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Title</th>
                  <th>Stage</th>
                  <th>Resolution</th>
                  <th>Entered</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((ticket) => (
                  <tr key={ticket.slug}>
                    <td className="mono">
                      <Link href={`/projects/${slug}/tickets/${ticket.slug}`}>
                        {ticket.ticket_key ?? ticket.slug}
                      </Link>
                    </td>
                    <td>{ticket.title}</td>
                    <td>{ticket.stage}</td>
                    <td>{ticket.resolution ?? "—"}</td>
                    <td className="mono muted">
                      {ticket.stage_entered_at
                        ? ticket.stage_entered_at.slice(0, 10)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="insights-pager">
          {hasPrev ? (
            <Link
              href={`/projects/${slug}/insights?${new URLSearchParams({
                q,
                type,
                ...(stage ? { stage } : {}),
                ...(resolution ? { resolution } : {}),
                ...(priority ? { priority } : {}),
                ...(created_by ? { created_by } : {}),
                history_stage: historyStage,
                history_offset: String(historyPrev),
              }).toString()}`}
            >
              ← Prev
            </Link>
          ) : (
            <span className="muted">← Prev</span>
          )}
          <span className="muted">
            {history.total === 0
              ? "0"
              : `${historyOffset + 1}–${Math.min(historyOffset + history.items.length, history.total)} of ${history.total}`}
          </span>
          {hasNext ? (
            <Link
              href={`/projects/${slug}/insights?${new URLSearchParams({
                q,
                type,
                ...(stage ? { stage } : {}),
                ...(resolution ? { resolution } : {}),
                ...(priority ? { priority } : {}),
                ...(created_by ? { created_by } : {}),
                history_stage: historyStage,
                history_offset: String(historyNext),
              }).toString()}`}
            >
              Next →
            </Link>
          ) : (
            <span className="muted">Next →</span>
          )}
        </div>
      </section>

      <section className="panel insights-section">
        <div className="panel-header">
          <h2>Delivery metrics</h2>
        </div>
        {!insights ? (
          <p className="empty">Could not load insights.</p>
        ) : (
          <div className="insights-metrics">
            <div>
              <h3>Throughput (done / week)</h3>
              {insights.throughput_per_week.length === 0 ? (
                <p className="empty">No done tickets with stage timestamps yet.</p>
              ) : (
                <ul className="insights-bars">
                  {insights.throughput_per_week.map((row) => (
                    <li key={row.week}>
                      <span className="mono">{row.week}</span>
                      <span
                        className="insights-bar"
                        style={{
                          width: `${Math.min(100, row.count * 18)}%`,
                        }}
                      />
                      <span className="mono">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3>Resolution mix (done)</h3>
              {insights.resolution_mix.length === 0 ? (
                <p className="empty">No done tickets yet.</p>
              ) : (
                <ul className="insights-mix">
                  {insights.resolution_mix.map((row) => (
                    <li key={row.resolution}>
                      <span>{row.resolution}</span>
                      <span className="mono">
                        {row.count} ({row.percent}%)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3>Estimate vs actual</h3>
              {insights.estimate_vs_actual.sample_size === 0 ? (
                <p className="empty">
                  No tickets with both tokens_estimate and tokens_actual.
                </p>
              ) : (
                <ul className="insights-mix">
                  <li>
                    <span>Sample</span>
                    <span className="mono">
                      {insights.estimate_vs_actual.sample_size}
                    </span>
                  </li>
                  <li>
                    <span>Avg actual/estimate</span>
                    <span className="mono">
                      {insights.estimate_vs_actual.avg_ratio ?? "—"}
                    </span>
                  </li>
                  <li>
                    <span>Median ratio</span>
                    <span className="mono">
                      {insights.estimate_vs_actual.median_ratio ?? "—"}
                    </span>
                  </li>
                  <li>
                    <span>Under / on / over (±10%)</span>
                    <span className="mono">
                      {insights.estimate_vs_actual.under_estimate_count} /{" "}
                      {insights.estimate_vs_actual.on_target_count} /{" "}
                      {insights.estimate_vs_actual.over_estimate_count}
                    </span>
                  </li>
                </ul>
              )}
            </div>

            <div>
              <h3>
                Open WIP age{" "}
                <span className="muted">
                  ({insights.open_wip.count} open · avg{" "}
                  {formatAge(insights.open_wip.avg_age_days)})
                </span>
              </h3>
              {insights.open_wip.items.length === 0 ? (
                <p className="empty">No open tickets.</p>
              ) : (
                <div className="insights-table-wrap">
                  <table className="insights-table">
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Title</th>
                        <th>Stage</th>
                        <th>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.open_wip.items.map((item) => (
                        <tr key={item.slug}>
                          <td className="mono">
                            <Link href={`/projects/${slug}/tickets/${item.slug}`}>
                              {item.ticket_key ?? item.slug}
                            </Link>
                          </td>
                          <td>{item.title}</td>
                          <td>{item.stage}</td>
                          <td className="mono">{formatAge(item.age_days)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="note muted">
              review→in_progress returns are deferred until durable transition
              events (TRA-29). Token metering remains self-reported.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
