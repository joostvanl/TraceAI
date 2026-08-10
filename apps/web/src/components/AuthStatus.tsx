import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { getSessionIdentity } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export async function AuthStatus() {
  const identity = await getSessionIdentity();
  if (!identity) return null;

  let unread = 0;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    const notifications = await client.listNotifications({ unreadOnly: true });
    unread = notifications.unread_count;
  } catch {
    unread = 0;
  }

  return (
    <div className="auth-status">
      <Link href="/inbox" className="auth-admin-link">
        Inbox
        {unread > 0 ? <span className="inbox-badge">{unread}</span> : null}
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
