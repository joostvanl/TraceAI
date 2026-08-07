/**
 * Upserts TRACEAI_TOKEN / TRACEAI_CREATE_SECRET / TRACEAI_API_URL on the Pi
 * env file used by deploy-traceai.sh, without echoing the token.
 *
 * Writes the create secret to scripts/.create-secret.local (gitignored) so
 * you can use it in the New ticket form.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = process.env.TRACEAI_PI_HOST ?? "joostvl@192.168.1.91";
const ENV_REMOTE = process.env.TRACEAI_ENV_FILE ?? "~/.config/traceai/traceai.env";
const secretPath = join("scripts", ".create-secret.local");

const mcp = JSON.parse(
  readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").replace(/^\uFEFF/, ""),
);
const token = mcp.mcpServers?.traceai?.env?.TRACEAI_TOKEN;
if (!token?.startsWith("trc_")) {
  console.error("No trc_ token found in ~/.cursor/mcp.json");
  process.exit(1);
}

const secret =
  process.env.TRACEAI_CREATE_SECRET ??
  (existsSync(secretPath)
    ? readFileSync(secretPath, "utf8").trim()
    : `trc_create_${randomBytes(12).toString("base64url")}`);

writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });

const remoteScript = `
set -euo pipefail
ENV_FILE=${ENV_REMOTE}
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
upsert() {
  local key="$1" value="$2"
  if grep -q "^\${key}=" "$ENV_FILE"; then
    # portable in-place replace
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {$0=k"="v} {print}' "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
upsert TRACEAI_API_URL "http://api:3847"
upsert TRACEAI_TOKEN ${JSON.stringify(token)}
upsert TRACEAI_CREATE_SECRET ${JSON.stringify(secret)}
echo "Pi env updated for New ticket form"
`;

execFileSync("ssh", ["-o", "BatchMode=yes", HOST, "bash", "-s"], {
  input: remoteScript,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log(`Create secret saved to ${secretPath}`);
console.log("Use that value in the New ticket form on the board.");
