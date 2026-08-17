"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { WikiTreeNode } from "@/lib/cms";

export type WikiTreeNavProps = {
  nodes: WikiTreeNode[];
  projectSlug: string;
  /** When set, highlight the active page link. */
  activeSlug?: string;
};

/**
 * Collapsed-by-default wiki tree.
 *
 * Visible depth starts at roots only. Children of every visible node are kept
 * in the in-memory tree (preload +1). Expanding a node mounts its children;
 * collapsing hides them without discarding data so re-expand is instant.
 * When a node is expanded, its children's children remain in memory as the
 * next preload layer.
 */
export function WikiTreeNav({
  nodes,
  projectSlug,
  activeSlug,
}: WikiTreeNavProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((slug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  if (nodes.length === 0) {
    return <p className="muted">No wiki pages yet.</p>;
  }

  return (
    <ul className="wiki-tree" role="tree">
      {nodes.map((node) => (
        <WikiTreeItem
          key={node.slug}
          node={node}
          projectSlug={projectSlug}
          activeSlug={activeSlug}
          expanded={expanded}
          onToggle={toggle}
        />
      ))}
    </ul>
  );
}

function WikiTreeItem({
  node,
  projectSlug,
  activeSlug,
  expanded,
  onToggle,
}: {
  node: WikiTreeNode;
  projectSlug: string;
  activeSlug?: string;
  expanded: Set<string>;
  onToggle: (slug: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.slug);
  const href = `/projects/${projectSlug}/wiki/${node.slug}`;
  const isActive = activeSlug === node.slug;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
      <div className="wiki-tree-row">
        {hasChildren ? (
          <button
            type="button"
            className="wiki-tree-toggle"
            aria-label={
              isOpen ? `Collapse ${node.title}` : `Expand ${node.title}`
            }
            aria-expanded={isOpen}
            onClick={() => onToggle(node.slug)}
          >
            {isOpen ? "−" : "+"}
          </button>
        ) : (
          <span
            className="wiki-tree-toggle wiki-tree-toggle-spacer"
            aria-hidden
          >
            ·
          </span>
        )}
        <Link
          href={href}
          className={isActive ? "wiki-tree-link is-active" : "wiki-tree-link"}
        >
          {node.title}
        </Link>
      </div>
      {hasChildren && isOpen ? (
        <ul className="wiki-tree" role="group">
          {node.children.map((child) => (
            <WikiTreeItem
              key={child.slug}
              node={child}
              projectSlug={projectSlug}
              activeSlug={activeSlug}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
