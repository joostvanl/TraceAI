import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { getSessionIdentity } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export async function AuthStatus() {
  const identity = await getSessionIdentity();
  if (!identity) return null;

  let waiting = 0;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const inbox = await client.listReviewInbox();
    waiting = inbox.awaiting_verdict.length;
  } catch {
    waiting = 0;
  }

  return (
    <div className="auth-status">
      <Link href="/inbox" className="auth-inbox-link">
        Inbox
        {waiting > 0 ? (
          <span className="inbox-badge" aria-label={`${waiting} wachtend`}>
            {waiting}
          </span>
        ) : null}
      </Link>
      <Link href="/account/agent-apis" className="auth-account-link">
        Agent APIs
      </Link>
      <Link href="/account/tokens" className="auth-account-link">
        API-tokens
      </Link>
      {(identity.is_platform_admin || identity.mode === "legacy") && (
        <Link href="/admin/users" className="auth-admin-link">
          Admin
        </Link>
      )}
      <span className="muted">{identity.display_name || identity.user}</span>
      <LogoutButton />
    </div>
  );
}
