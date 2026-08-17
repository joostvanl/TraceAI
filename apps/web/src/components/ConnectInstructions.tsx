import type { HomepageConnectContent } from "@/lib/cms";

export function ConnectInstructions({
  connect,
  headingLevel = "h1",
}: {
  connect: HomepageConnectContent;
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;
  return (
    <section className="connect" aria-labelledby="connect-heading">
      <p className="eyebrow">{connect.eyebrow}</p>
      <Heading id="connect-heading">{connect.heading}</Heading>
      <p className="lede">{connect.lede}</p>

      <ol className="steps">
        {connect.steps.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <pre className="code-block">{step.body}</pre>
          </li>
        ))}
      </ol>

      {connect.mcpConfig ? (
        <pre className="code-block">{connect.mcpConfig}</pre>
      ) : null}

      <div className="connect-grid">
        <div className="panel connect-panel">
          <h2>MCP tools</h2>
          <ul className="tool-list">
            {connect.tools.map((tool) => (
              <li key={tool}>
                <code>{tool}</code>
              </li>
            ))}
          </ul>
          {connect.toolsNote ? (
            <p className="muted note">{connect.toolsNote}</p>
          ) : null}
        </div>
        <div className="panel connect-panel">
          <h2>Rules</h2>
          <ul className="rules-list">
            {connect.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
