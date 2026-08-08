/**
 * Upserts TRACEAI_TOKEN / TRACEAI_API_URL / TRACEAI_SESSION_SECRET on the
 * Pi env file used by deploy-traceai.sh, without echoing secrets.
 *
 * UI username/password live in Aurora (`app_login` / `default`) — not in env.
 * Password is hashed in Aurora; TraceAI verifies via management API.
 * Optionally writes scripts/.ui-login.local (gitignored) for e2e: username
 * from Aurora, password must be supplied via env TRACEAI_UI_E2E_PASSWORD
 * (or kept from an existing local file) because Aurora never returns it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = process.env.TRACEAI_PI_HOST ?? "joostvl@192.168.1.91";
const ENV_REMOTE = process.env.TRACEAI_ENV_FILE ?? "~/.config/traceai/traceai.env";
const loginPath = join("scripts", ".ui-login.local");
const AURORA_API =
  process.env.AURORA_API_URL?.replace(/\/$/, "") ??
  "https://aurora-api.joostvanleeuwaarden.com";

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

const sessionSecret =
  process.env.TRACEAI_SESSION_SECRET ??
  existing.sessionSecret ??
  randomBytes(32).toString("base64url");

async function loadAuroraUsername() {
  const userToken =
    process.env.AURORA_USER_TOKEN ??
    process.env.AURORA_MANAGEMENT_TOKEN ??
    "";
  const websiteId =
    process.env.AURORA_WEBSITE_ID ?? "cmsiyy8oy00quoc01zzam3t6p";
  if (!userToken) return null;

  let bearer = userToken;
  if (userToken.startsWith("aur_u_")) {
    const select = await fetch(`${AURORA_API}/api/v1/auth/select-website`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ websiteId }),
    });
    if (!select.ok) {
      console.warn(`Aurora select-website failed: ${select.status}`);
      return null;
    }
    const selected = await select.json();
    bearer = selected.token;
  }

  const res = await fetch(
    `${AURORA_API}/api/v1/admin/content-types/app_login/entries?slug=default&limit=1&locale=en-US`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  if (!res.ok) {
    console.warn(`Aurora app_login read failed: ${res.status}`);
    return null;
  }
  const body = await res.json();
  const entry = body.items?.[0];
  const user = entry?.fields?.username?.trim();
  const passwordSet = entry?.fields?.password?.set === true;
  if (!user || !passwordSet) return null;
  return user;
}

const auroraUser = await loadAuroraUsername();
const login = {
  user: auroraUser ?? existing.user ?? "joost",
  // Aurora never returns the password; e2e must keep a local copy.
  password:
    process.env.TRACEAI_UI_E2E_PASSWORD ??
    existing.password ??
    "",
};

writeFileSync(
  loginPath,
  `${JSON.stringify({ ...login, sessionSecret }, null, 2)}\n`,
  { mode: 0o600 },
);

const remoteScript = `
set -euo pipefail
ENV_FILE=${ENV_REMOTE}
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
upsert() {
  local key="$1" value="$2"
  if grep -q "^\${key}=" "$ENV_FILE"; then
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {$0=k"="v} {print}' "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
upsert TRACEAI_API_URL "http://api:3847"
upsert TRACEAI_TOKEN ${JSON.stringify(token)}
upsert TRACEAI_SESSION_SECRET ${JSON.stringify(sessionSecret)}
sed -i '/^TRACEAI_UI_USER=/d' "$ENV_FILE"
sed -i '/^TRACEAI_UI_PASSWORD=/d' "$ENV_FILE"
sed -i '/^TRACEAI_CREATE_SECRET=/d' "$ENV_FILE"
echo "Pi env updated (token + session secret; UI login stays in Aurora)"
`;

execFileSync("ssh", ["-o", "BatchMode=yes", HOST, "bash", "-s"], {
  input: remoteScript,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log(`Local e2e login hint saved to ${loginPath} (user: ${login.user})`);
if (!login.password) {
  console.log(
    "No e2e password on disk — set TRACEAI_UI_E2E_PASSWORD or edit scripts/.ui-login.local.",
  );
}
console.log(
  "Manage Username/Password in Aurora Admin → App login → default.",
);
