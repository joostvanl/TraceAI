import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { getSessionUser, isLoginConfigured } from "@/lib/session";

export async function AuthStatus() {
  if (!isLoginConfigured()) return null;
  const user = await getSessionUser();

  return (
    <div className="auth-status">
      {user ? (
        <>
          <span className="muted">{user}</span>
          <LogoutButton />
        </>
      ) : (
        <Link href="/login" className="btn btn-small">
          Sign in
        </Link>
      )}
    </div>
  );
}
