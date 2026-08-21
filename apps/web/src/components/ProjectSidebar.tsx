"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  boardHref,
  isBoardActive,
  isPageActive,
  menuOpenAfter,
  type NavWorkflow,
  type ProjectPageKind,
} from "@/lib/project-nav";

type Props = {
  projectSlug: string;
  projectName: string;
  workflows: NavWorkflow[];
  defaultWorkflow: string | null;
};

const PAGE_LINKS: Array<{
  label: string;
  kind: ProjectPageKind;
  href: (projectSlug: string) => string;
}> = [
  {
    label: "Insights",
    kind: "insights",
    href: (slug) => `/projects/${slug}/insights`,
  },
  {
    label: "Wiki",
    kind: "wiki",
    href: (slug) => `/projects/${slug}/wiki`,
  },
  {
    label: "Settings",
    kind: "settings",
    href: (slug) => `/projects/${slug}/settings`,
  },
  {
    label: "API-tokens",
    kind: "tokens",
    href: (slug) => `/projects/${slug}/tokens`,
  },
];

export function ProjectSidebar({
  projectSlug,
  projectName,
  workflows,
  defaultWorkflow,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workflowQuery = searchParams.get("workflow") ?? undefined;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen((open) => menuOpenAfter(open, "close"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div
      className={`project-nav-slot${menuOpen ? " project-nav-slot--open" : ""}`}
    >
      <button
        type="button"
        className="project-nav-toggle"
        aria-expanded={menuOpen}
        aria-controls="project-nav"
        onClick={() => setMenuOpen((open) => menuOpenAfter(open, "toggle"))}
      >
        <span aria-hidden="true">☰</span> Menu
      </button>
      <button
        type="button"
        className="project-nav-overlay"
        tabIndex={-1}
        aria-label="Sluit menu"
        onClick={() => setMenuOpen((open) => menuOpenAfter(open, "close"))}
      />
      <nav id="project-nav" className="project-nav" aria-label="Project">
        <div className="project-nav-toolbar">
          <p className="project-nav-title">{projectName}</p>
          <button
            type="button"
            className="project-nav-close"
            onClick={() => setMenuOpen((open) => menuOpenAfter(open, "close"))}
          >
            Sluiten
          </button>
        </div>
        {workflows.length > 0 ? (
          <div className="project-nav-section">
            <p className="project-nav-heading">Boards</p>
            <ul className="project-nav-list">
              {workflows.map((workflow) => {
                const href = boardHref(
                  projectSlug,
                  workflow.slug,
                  defaultWorkflow,
                );
                const active = isBoardActive({
                  pathname,
                  workflowQuery,
                  projectSlug,
                  workflowSlug: workflow.slug,
                  defaultWorkflow,
                });
                return (
                  <li key={workflow.slug}>
                    <Link
                      href={href}
                      className={`project-nav-item${active ? " project-nav-item--active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      {workflow.name}
                      {defaultWorkflow === workflow.slug ? " (default)" : ""}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <div className="project-nav-section">
          <p className="project-nav-heading">Pagina&apos;s</p>
          <ul className="project-nav-list">
            {PAGE_LINKS.map((item) => {
              const href = item.href(projectSlug);
              const active = isPageActive(pathname, projectSlug, item.kind);
              return (
                <li key={item.label}>
                  <Link
                    href={href}
                    className={`project-nav-item${active ? " project-nav-item--active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
    </div>
  );
}
