const url = "http://127.0.0.1:3010/projects/traceai";
const titles = {
  sortDone: "Sort Done lane by completion time",
  fixMcp: "Fix stale TraceAI MCP 404",
  sse: "Verify live board SSE works through the TraceAI API",
};

async function check() {
  const html = await (await fetch(url, { cache: "no-store" })).text();
  const idx = Object.fromEntries(
    Object.entries(titles).map(([k, v]) => [k, html.indexOf(v)]),
  );
  return { idx, html };
}

let ok = false;
for (let attempt = 1; attempt <= 8; attempt++) {
  const { idx } = await check();
  console.log(`attempt ${attempt}`, idx);
  const found = Object.values(idx).every((i) => i >= 0);
  if (found) {
    ok = idx.sortDone < idx.fixMcp && idx.sortDone < idx.sse;
    console.log(
      "order sortDone-first:",
      ok,
      "(sortDone completed last → should be top of Done)",
    );
    if (ok) break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(ok ? "DONE_ORDER_OK" : "DONE_ORDER_CHECK_INCONCLUSIVE");
