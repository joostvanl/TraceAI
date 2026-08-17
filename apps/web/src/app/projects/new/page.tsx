import Link from "next/link";
import { CreateProjectForm } from "@/components/CreateProjectForm";

export const dynamic = "force-dynamic";

export default function NewProjectPage() {
  return (
    <section className="projects-section" aria-labelledby="new-project-heading">
      <nav className="breadcrumb">
        <Link href="/">Projects</Link>
        <span>/</span>
        <span>New</span>
      </nav>

      <h1 id="new-project-heading">New project</h1>
      <p className="lede">
        Creates a project for you as admin, seeds the Standard Worker workflow,
        and adds a starter handbook wiki (Home, Getting started, Architecture,
        Product &amp; process, Engineering, Operations, Design packs).
      </p>

      <section className="panel">
        <CreateProjectForm />
      </section>
    </section>
  );
}
