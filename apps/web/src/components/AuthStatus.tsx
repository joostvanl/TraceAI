import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { getSessionIdentity } from "@/lib/session";

export async function AuthStatus() {
  const identity = await getSessionIdentity();
  if (!identity) return null;

  return (
    <div className="auth-status">
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
