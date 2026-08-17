"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          slug: slug.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        project?: { slug?: string };
        slug?: string;
      };
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/projects/new")}`);
        return;
      }
      if (!res.ok) {
        setError(body.message ?? `Create failed (${res.status})`);
        return;
      }
      const createdSlug = body.project?.slug ?? body.slug;
      if (!createdSlug) {
        setError("Project created but slug missing from response");
        return;
      }
      router.push(`/projects/${createdSlug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="create-ticket-form" onSubmit={onSubmit}>
      <label>
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Project name"
          disabled={submitting}
        />
      </label>

      <label>
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Optional short description"
          disabled={submitting}
        />
      </label>

      <label>
        <span>Slug (optional)</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          maxLength={80}
          placeholder="Derived from name when empty"
          disabled={submitting}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          title="Lowercase letters, numbers, and hyphens"
        />
      </label>

      {error ? <p className="create-ticket-error">{error}</p> : null}

      <button type="submit" className="btn primary" disabled={submitting}>
        {submitting ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
