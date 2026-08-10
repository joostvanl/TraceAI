import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateUserForm, UsersTable } from "@/components/AdminUsers";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";
import { createTraceServerClient } from "@/lib/traceai-server";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const configured = await isLoginConfigured();
  if (!configured) redirect("/login");
  const identity = await getSessionIdentity();
  if (!identity) redirect("/login");
  if (!identity.is_platform_admin && identity.mode !== "legacy") {
    return (
      <div className="panel">
        <nav className="breadcrumb">
          <Link href="/">Projects</Link>
          <span>/</span>
          <span>Admin</span>
        </nav>
        <h1>Gebruikersbeheer</h1>
        <p className="muted">Alleen platform-admins kunnen gebruikers beheren.</p>
      </div>
    );
  }

  let users: Array<{
    slug: string;
    username: string;
    display_name: string;
    email: string | null;
    status: string;
    is_platform_admin: boolean;
    password_set: boolean;
  }> = [];
  let loadError: string | null = null;
  try {
    const client = createTraceServerClient({
      asHumanCapable: true,
      identity,
    });
    users = (await client.listTraceaiUsers()) as typeof users;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="panel">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>Admin · Gebruikers</span>
      </nav>
      <h1>Gebruikersbeheer</h1>
      <p className="muted">
        Accounts staan in Aurora (<code>traceai_user</code>); deze UI beheert ze
        via TraceAI zodat gebruikers geen Aurora-toegang nodig hebben.
      </p>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      <UsersTable users={users} />
      <CreateUserForm />
    </div>
  );
}
