import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { getSessionUser, isLoginConfigured, sessionSecret } from "@/lib/session";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ next?: string | string[] }>;
};

function safeNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  // Only same-origin paths; "//host" would leave the site.
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default async function LoginPage({ searchParams }: Props) {
  const next = safeNext((await searchParams).next);
  const user = await getSessionUser();
  if (user) redirect(next);

  const configured = Boolean(sessionSecret()) && (await isLoginConfigured());

  return (
    <div className="auth-page">
      <nav className="breadcrumb">
        <Link href="/login">TraceAI</Link>
        <span>/</span>
        <span>Sign in</span>
      </nav>
      <h1>Sign in</h1>
      <p className="lede">
        Log in om TraceAI te gebruiken. Username en password worden beheerd in
        Aurora CMS (<code>app_login</code> / <code>default</code>; password is
        gehashed).
      </p>

      {configured ? (
        <LoginForm next={next} />
      ) : (
        <div className="empty">
          UI login is niet geconfigureerd. Zet <strong>Username</strong> en{" "}
          <strong>Password</strong> op de Aurora-entry{" "}
          <code>app_login</code> / <code>default</code> en zorg dat{" "}
          <code>TRACEAI_SESSION_SECRET</code> op de web-server staat.
        </div>
      )}
    </div>
  );
}
