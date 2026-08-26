import { redirect } from "next/navigation";
import { AccountAgentApisPanel } from "@/components/AccountAgentApisPanel";
import { getSessionIdentity, isLoginConfigured } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AccountAgentApisPage() {
  if (!(await isLoginConfigured())) {
    redirect("/login");
  }
  const identity = await getSessionIdentity();
  if (!identity) {
    redirect("/login");
  }

  return (
    <section className="account-page" aria-labelledby="account-agent-apis-heading">
      <p className="eyebrow">Account</p>
      <h1 id="account-agent-apis-heading">Agent APIs</h1>
      <p className="lede">
        Koppel je eigen Cursor API-key zodat TraceAI Cloud-agents kan wekken na
        een human-gate oordeel. De key blijft van jou; nudges gebruiken de key
        van wie het ticket claimde.
      </p>
      {identity.mode !== "personal" ? (
        <div className="empty">
          Agent APIs werken alleen met een persoonlijk TraceAI-account. De
          gedeelde (legacy) login kan geen keys opslaan.
        </div>
      ) : (
        <AccountAgentApisPanel />
      )}
    </section>
  );
}
