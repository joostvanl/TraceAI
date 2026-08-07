import type { ReactNode } from "react";
import Link from "next/link";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AuthStatus } from "@/components/AuthStatus";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata = {
  title: "TraceAI",
  description: "Issue tracker for AI agent work — live boards plus backlog wish capture",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            TraceAI
          </Link>
          <span className="tagline">Agent work, human overview</span>
          <AuthStatus />
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
