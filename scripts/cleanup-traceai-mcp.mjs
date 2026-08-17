/**
 * Kills orphan TraceAI MCP node processes so a Cursor reload starts clean.
 *
 * Cursor sometimes leaves old `node …/packages/mcp/dist/stdio.js` (or legacy
 * `…/dist/index.js`) processes running after an MCP toggle/reload. Those keep
 * the previous TRACEAI_API_URL (often loopback) and cause confusing 404s.
 * and silently write to the wrong API instance (breaking the live board).
 *
 *   node scripts/cleanup-traceai-mcp.mjs
 *
 * After this, reload the `traceai` MCP server in Cursor.
 */
import { execFileSync } from "node:child_process";

function listPids() {
  if (process.platform === "win32") {
    const ps = `
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -like '*TraceAI*packages*mcp*dist*index.js*' -or
    $_.CommandLine -like '*TraceAI*packages*mcp*dist*stdio.js*'
  } |
  Select-Object -ExpandProperty ProcessId
`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", ps],
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }

  const out = execFileSync(
    "bash",
    [
      "-lc",
      "ps -ax -o pid=,command= | grep -E '[T]raceAI.*/packages/mcp/dist/(index|stdio)\\.js' | awk '{print $1}'",
    ],
    { encoding: "utf8" },
  );
  return out
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

const pids = listPids();
if (pids.length === 0) {
  console.log("No TraceAI MCP node processes found.");
  process.exit(0);
}

console.log(`Stopping ${pids.length} TraceAI MCP process(es): ${pids.join(", ")}`);
for (const pid of pids) {
  try {
    process.kill(pid);
    console.log(`  stopped ${pid}`);
  } catch (error) {
    console.log(`  could not stop ${pid}: ${String(error).slice(0, 80)}`);
  }
}
console.log("Done. Reload the `traceai` MCP server in Cursor now.");
