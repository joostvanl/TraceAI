import Link from "next/link";
import { redirect } from "next/navigation";
import { ConnectInstructions } from "@/components/ConnectInstructions";
import { LoginForm } from "@/components/LoginForm";
import { getHomepageConnect } from "@/lib/cms";
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
  const connect = await getHomepageConnect();

  return (
    <div className="login-layout">
      <div className="login-pane">
        <nav className="breadcrumb">
          <Link href="/login">TraceAI</Link>
          <span>/</span>
          <span>Sign in</span>
        </nav>
        <h1>Sign in</h1>
        <p className="lede">
          Log in with your TraceAI account to open boards, inbox, and settings.
        </p>

        {configured ? (
          <LoginForm next={next} />
        ) : (
          <div className="empty">
            UI login is not configured yet. Ask an admin to create a TraceAI
            user account and set <code>TRACEAI_SESSION_SECRET</code> on the web
            server.
          </div>
        )}
      </div>

      <div className="login-connect-pane">
        <ConnectInstructions connect={connect} />
      </div>
    </div>
  );
}
