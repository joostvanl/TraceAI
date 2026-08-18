import type { WorkflowDocument } from "./types.js";

/** Live TraceAI Standard Worker playbook (v3), used when seeding new projects. */
export const STANDARD_WORKER_WORKFLOW_DOCUMENT: WorkflowDocument = {
  version: 3,
  agent_policy: {
    summary:
      "TraceAI tickets must be self-contained for junior agents. Keep the ticket description a thin executable playbook; put rich design docs (functional/technical design, use cases, test cases) in a wiki design pack under design-packs/, not in the ticket body. Every workflow transition needs a Markdown comment describing completed work, plus tokens_used. Human-gated stages require a human verdict in the UI; the agent performs the transition afterwards. Playbook and estimate gates are target-scoped via workflow JSON.\nWhen a ticket has subtickets, treat the parent as the single place for human communication and human-gate verdicts (approve/reject/dismiss). Subtickets structure the work and may move through non-gated stages with their own transition comments; do not ask the human for a separate verdict on a subticket. After a parent verdict, apply/cascade it to gated descendants (when supported) and then transition those tickets according to the same verdict targets. Do not invent a second human review thread on children.",
    ticket_description: [
      "Write descriptions that a junior agent with no chat history can execute alone.",
      "Keep the ticket THIN: only Context, Goal, What to implement (concrete steps), Out of scope, Acceptance criteria, and optional dependency ticket slugs.",
      "Do NOT put full functional design, technical design with long code snippets, use-case catalogues, or full test matrices in the ticket description — those belong in a wiki design pack.",
      "For non-trivial tickets, create or update a wiki design pack under parent slug design-packs (create design-packs if missing). Suggested pack slug: <ticket-key-lower>-design (e.g. tra-42-design). Child pages (Markdown) as needed: functional-design, technical-design, use-cases, test-cases.",
      "Link the pack from the ticket with a short section '## Design pack' containing the pack root slug (and child slugs if useful). Omit the section only for trivial tickets where a pack adds no value.",
      "Handbook wiki pages (Home, Architecture, feature docs at the wiki root) are the durable product truth — never dump per-ticket design packs into the handbook navigation tree.",
      "Use Markdown headings (##) for required sections.",
      "Link related ticket slugs when there are dependencies.",
      "Never leave only a one-line title-as-description.",
    ],
    on_every_transition: [
      "Before changing stage, post one Markdown transition comment on the ticket; this single comment must satisfy the global rules plus all applicable on_exit and on_enter rules.",
      "Start with '## Vorige stap' describing what was true / done in the stage you leave.",
      "Continue with '## Deze stap' describing what you completed, why the transition is appropriate, and what the next stage should verify.",
      "List concrete artifacts (files, endpoints, commands, wiki slugs) when relevant.",
      "Pass tokens_used: a non-negative integer estimate of LLM tokens (prompt+completion) spent on this step.",
      "Call get_ticket immediately before transition_ticket. Pass expected_stage (current stage). When the current stage has require_human_approval_on_exit, also pass expected_review_state (current review_state, or null). Workflows with require_expected_stage_on_transition refuse the call without the required fields. On STAGE_CONFLICT, read the error body; do not retry the same transition.",
      "Stages with require_human_approval_on_exit need a human verdict (Goedkeuren/Afkeuren in the UI) before the agent may transition out. Exit requirements that name targets (require_*_on_exit_to) apply only to those destinations.",
      "Wiki writes only via TraceAI MCP (create_wiki_page / update_wiki_page). Never Aurora MCP for wiki.",
    ],
    min_description_chars: 280,
    require_description_headings: [
      "## Context",
      "## Goal",
      "## What to implement",
      "## Acceptance criteria",
    ],
    require_tokens_used_on_transition: true,
    require_expected_stage_on_transition: true,
  },
  stages: [
    {
      key: "backlog",
      name: "Backlog",
      transitions: ["in_refinement"],
      agent: {
        purpose: "Parked ideas / not yet ready to refine.",
        on_exit: [
          "Confirm the wish is clear enough to refine into a junior-agent playbook (and, if non-trivial, a wiki design pack).",
          "Add a comment summarizing why it is ready for In Refinement.",
        ],
        require_comment_on_exit: true,
        require_human_approval_on_exit: false,
      },
    },
    {
      key: "in_refinement",
      name: "In Refinement",
      transitions: ["todo", "backlog", "done"],
      agent: {
        purpose:
          "Sharpen the wish into a thin junior-agent playbook on the ticket, plus (when non-trivial) a wiki design pack under design-packs/ with structured Markdown pages. Use repo docs and handbook wiki pages (not ticket archives) for accuracy. Present a clear tokens_estimate so human approval includes cost.",
        on_enter: [
          "Confirm the ticket is ready to be rewritten as a THIN playbook: Context / Goal / What to implement / Acceptance criteria (plus Out of scope when useful).",
          "Decide whether a design pack is needed (non-trivial behaviour, APIs, UX, or multi-file design). If yes, plan pack slug under design-packs.",
          "Add links in the ticket description to each individual design pack page that was created during this step.",
        ],
        on_exit: [
          "Wait for the human verdict on the playbook (Goedkeuren/Afkeuren in the UI); only then transition.",
          "When moving to To do: ticket description must stay thin and playbook-complete; FO/TO/use cases/test cases must live in the design pack (or be explicitly unnecessary for a trivial ticket).",
          "When moving to To do on a non-trivial ticket: ensure wiki parent design-packs exists; create/update pack root + needed children (functional-design, technical-design, use-cases, test-cases); link them via '## Design pack' on the ticket.",
          "If the verdict is rejected, move the ticket back to Backlog and reference the reason (## Reden).",
          "Pass tokens_estimate when leaving to To do.",
          "Before leaving to To do, reevaluate the estimate with the most recent situation. If there are any changes or new insights, update tokens_estimate accordingly (and mention the delta in ## Deze stap).",
          "When Human rejects with a comment to not take this ticket any further, move the ticket to Done including the given reason (## Reden), a non-completed resolution, and ## Wiki (N/A or pack slug if anything was written).",
        ],
        require_comment_on_exit: true,
        require_tokens_estimate_on_exit_to: ["todo"],
        require_playbook_description_on_exit_to: ["todo"],
        require_human_approval_on_exit: true,
        human_approve_to: "todo",
        human_reject_to: ["backlog"],
        human_dismiss_to: "done",
      },
    },
    {
      key: "todo",
      name: "To do",
      transitions: ["in_progress", "backlog", "in_refinement"],
      agent: {
        purpose: "Ready to start; next up for an agent.",
        on_enter: [
          "Confirm dependencies are clear in the description.",
          "If '## Design pack' is present, confirm the linked wiki pages exist before starting implementation.",
        ],
        on_exit: [
          "When moving to In progress, describe the first implementation step and confirm that work can start (reference design-pack slugs if used).",
          "When returning to Backlog or In Refinement, explain why the ticket is no longer ready.",
        ],
        require_comment_on_exit: true,
        require_resolution_on_enter: false,
        require_human_approval_on_exit: false,
      },
    },
    {
      key: "in_progress",
      name: "In progress",
      transitions: ["review", "todo"],
      agent: {
        purpose:
          "Active implementation. Follow the thin ticket playbook; use the design pack as the detailed design source when present. Update the design pack if implementation diverges materially from the agreed design.",
        on_exit: [
          "Comment what was implemented (files, APIs, behaviour).",
          "If the design pack changed during implementation, list updated wiki slugs in ## Deze stap.",
          "If moving to Review, include a short test report (see review stage rules).",
        ],
        require_comment_on_exit: true,
        comment_template:
          "## Vorige stap\n...\n\n## Deze stap\n...\n\n## Testverslag\n- Test: ...\n- Resultaat: PASS/FAIL\n\n## Uitslag\nPASS|FAIL",
      },
    },
    {
      key: "review",
      name: "Review",
      transitions: ["done", "todo"],
      agent: {
        purpose:
          "Verification before Done — a human verdict is required before the agent may move on.",
        on_enter: [
          "Transition comment MUST include a short test report.",
          "List each test/check run and PASS/FAIL.",
          "Include overall ## Uitslag PASS or FAIL.",
          "If a design pack exists, verify acceptance criteria and tests against the pack (not only the thin ticket summary).",
        ],
        on_exit: [
          "Wait for the human verdict (Goedkeuren/Afkeuren in the UI); only then transition.",
          "If the verdict is Afgekeurd, move the ticket to To do and reference the reason (## Reden).",
          "Only move to Done with resolution completed when every acceptance criterion has been verified separately, all relevant checks pass, and the overall ## Uitslag is PASS.",
          "When moving to Done with another resolution, document the reason and any follow-up action.",
          "When moving to Done, prepare ## Wiki: (1) update handbook pages only with lasting product truth distilled from this work; (2) keep full per-ticket FO/TO/use cases/tests under design-packs/ (do not promote the whole pack into handbook root); (3) list all touched wiki slugs, or N/A with reason.",
        ],
        require_comment_on_enter: true,
        require_comment_on_exit: true,
        require_comment_sections_on_enter: ["## Testverslag", "## Uitslag"],
        comment_template:
          "## Vorige stap\nImplementation completed: ...\n\n## Deze stap\nReady for review.\n\n## Testverslag\n- check — PASS\n\n## Uitslag\nPASS",
        require_human_approval_on_exit: true,
        human_approve_to: "done",
        human_reject_to: ["todo"],
      },
    },
    {
      key: "done",
      name: "Done",
      transitions: ["todo"],
      agent: {
        purpose:
          "Closed with an explicit resolution and supporting evidence or rationale. Wiki DoD: distill lasting knowledge into the handbook; retain detailed ticket design under design-packs/ when a pack was used.",
        on_enter: [
          "For resolution completed: confirm every acceptance criterion separately, record the supporting evidence, confirm all relevant checks passed, and confirm ## Uitslag is PASS.",
          "For resolution superseded, cancelled, duplicate, or verification-only: document the reason, any follow-up action, and why unmet or non-applicable criteria and checks are acceptable.",
          "Pass resolution: completed | superseded | cancelled | duplicate | verification-only (Done ≠ always functionally shipped).",
          "Wiki via TraceAI MCP only. Prefer two outcomes: (A) handbook page(s) updated with current product behaviour; (B) design pack under design-packs/ left as the detailed audit trail when one exists. Do not clutter handbook root with per-ticket design dumps.",
          "Always include ## Wiki: list page slug(s) touched (handbook and/or design-packs/...), or state N/A with a brief reason.",
        ],
        on_exit: [
          "Reopening is only for tickets that turn out to be incomplete; explain in the comment what was missed and what will be picked up again.",
        ],
        require_comment_on_enter: true,
        require_comment_on_exit: true,
        require_comment_sections_on_enter: ["## Wiki"],
        require_resolution_on_enter: true,
      },
    },
  ],
  editor_layout: {
    nodes: [
      { id: "backlog", x: -206.02589039426175, y: 86.89219012998223 },
      { id: "in_refinement", x: 16.743634280782686, y: 287.91440225446337 },
      { id: "todo", x: 242.9592540208182, y: -19.936756884742074 },
      { id: "in_progress", x: 532.587151868832, y: -18.8988302741225 },
      { id: "review", x: 758.8027716088675, y: -28.59097264441001 },
      { id: "done", x: 834.5389068442914, y: 202.29739670999408 },
    ],
  },
};
