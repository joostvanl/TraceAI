import { redirect } from "next/navigation";
import { AccountTokensPanel } from "@/components/AccountTokensPanel";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AccountTokensPage() {
  if (!(await isLoginConfigured())) {
    redirect("/login");
  }
  const identity = await getSessionIdentity();
  if (!identity) {
    redirect("/login");
  }

  return (
    <section className="account-page" aria-labelledby="account-tokens-heading">
      <p className="eyebrow">Account</p>
      <h1 id="account-tokens-heading">API-tokens</h1>
      <p className="lede">
        Maak persoonlijke TraceAI-tokens (<code>trc_…</code>) voor agents en MCP.
        Alleen jij ziet en beheert je eigen tokens.
      </p>
      {identity.mode !== "personal" ? (
        <div className="empty">
          API-tokens werken alleen met een persoonlijk TraceAI-account. De
          gedeelde (legacy) login kan geen tokens aanmaken.
        </div>
      ) : (
        <AccountTokensPanel />
      )}
    </section>
  );
}
