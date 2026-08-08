import { LogoutButton } from "@/components/LogoutButton";
import { getSessionUser } from "@/lib/session";

export async function AuthStatus() {
  const user = await getSessionUser();
  if (!user) return null;

  return (
    <div className="auth-status">
      <span className="muted">{user}</span>
      <LogoutButton />
    </div>
  );
}
