/**
 * Upserts TRACEAI_TOKEN / TRACEAI_API_URL and the UI login credentials on the
 * Pi env file used by deploy-traceai.sh, without echoing the token.
 *
 * Writes the login to scripts/.ui-login.local (gitignored) so you can sign in
 * on the board and so the e2e script can reuse it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = process.env.TRACEAI_PI_HOST ?? "joostvl@192.168.1.91";
const ENV_REMOTE = process.env.TRACEAI_ENV_FILE ?? "~/.config/traceai/traceai.env";
const loginPath = join("scripts", ".ui-login.local");

const mcp = JSON.parse(
  readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").replace(/^\uFEFF/, ""),
);
const token = mcp.mcpServers?.traceai?.env?.TRACEAI_TOKEN;
if (!token?.startsWith("trc_")) {
  console.error("No trc_ token found in ~/.cursor/mcp.json");
  process.exit(1);
}

const existing = existsSync(loginPath)
  ? JSON.parse(readFileSync(loginPath, "utf8"))
  : {};

const user = process.env.TRACEAI_UI_USER ?? existing.user ?? "joost";
const password =
  process.env.TRACEAI_UI_PASSWORD ??
  existing.password ??
  randomBytes(12).toString("base64url");

writeFileSync(loginPath, `${JSON.stringify({ user, password }, null, 2)}\n`, {
  mode: 0o600,
});

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
upsert TRACEAI_UI_USER ${JSON.stringify(user)}
upsert TRACEAI_UI_PASSWORD ${JSON.stringify(password)}
sed -i '/^TRACEAI_CREATE_SECRET=/d' "$ENV_FILE"
echo "Pi env updated for the UI login"
`;

execFileSync("ssh", ["-o", "BatchMode=yes", HOST, "bash", "-s"], {
  input: remoteScript,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log(`UI login saved to ${loginPath} (user: ${user})`);
console.log("Sign in at /login on the board with those credentials.");
