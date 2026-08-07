/**
 * Listens to several TraceAI API instances at once and reports which one emits
 * ticket events. Use it to find out where an agent's MCP writes actually land:
 * every instance shares one Aurora store, so the data alone cannot tell you.
 *
 *   node scripts/which-instance-emits.mjs
 *   ...then perform an MCP write (transition/comment) while it runs.
 */
const targets = [
  ["local ", "http://127.0.0.1:3847"],
  ["public", "https://traceai.joostvanleeuwaarden.com"],
];
const project = process.env.TRACEAI_PROJECT ?? "traceai";
const windowMs = Number(process.env.WINDOW_MS ?? 45000);
const started = Date.now();

const stamp = () => `+${String(Date.now() - started).padStart(6)}ms`;

async function listen(label, base) {
  const res = await fetch(`${base}/events?project=${project}`, {
    headers: { Accept: "text/event-stream" },
  });
  console.log(`${stamp()} ${label} stream open (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let name = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (name === "ping" || name === "connected") continue;
      let slug = "";
      try {
        slug = JSON.parse(data).ticket?.slug ?? "";
      } catch {}
      console.log(`${stamp()} ${label} <<< ${name} ${slug}`);
    }
  }
}

console.log(`Listening ${windowMs / 1000}s. Do an MCP write now.`);
for (const [label, base] of targets) {
  listen(label, base).catch((error) =>
    console.log(`${stamp()} ${label} error: ${String(error).slice(0, 100)}`),
  );
}

setTimeout(() => {
  console.log(`${stamp()} window closed`);
  process.exit(0);
}, windowMs);
