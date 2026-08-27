"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type Props = {
  ticketSlug: string;
};

/**
 * Re-fetches ticket detail when the route is shown (mount, slug change,
 * bfcache restore). Does not poll and does not open SSE.
 */
export function TicketDetailRefresh({ ticketSlug }: Props) {
  const router = useRouter();

  useEffect(() => {
    router.refresh();

    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        router.refresh();
      }
    }

    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [router, ticketSlug]);

  return null;
}
