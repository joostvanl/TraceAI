import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { getSessionUser, isLoginConfigured } from "@/lib/session";

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

  return (
    <div className="auth-page">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>Sign in</span>
      </nav>
      <h1>Sign in</h1>
      <p className="lede">
        Log in om wensen als backlog-ticket toe te voegen. Boards blijven ook
        zonder login zichtbaar.
      </p>

      {isLoginConfigured() ? (
        <LoginForm next={next} />
      ) : (
        <div className="empty">
          UI login is niet geconfigureerd. Zet <code>TRACEAI_UI_USER</code> en{" "}
          <code>TRACEAI_UI_PASSWORD</code> op de web-server.
        </div>
      )}
    </div>
  );
}
