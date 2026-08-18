/** Stale-state guard for ticket transitions (TRA-73). Own module, not types.ts. */

export const COMMENT_BODY_MAX = 1500;

export const MISSING_EXPECTED_STAGE =
  "expected_stage is required on this workflow (require_expected_stage_on_transition).";

export const MISSING_EXPECTED_REVIEW_STATE =
  "expected_review_state is required when leaving a human-gated stage (pass null if you expect no verdict).";

export type RecentComment = {
  author: string;
  createdAt: string;
  body: string;
  truncated: boolean;
};

export class StageConflictError extends Error {
  readonly code = "STAGE_CONFLICT";
  readonly status = 409;

  constructor(
    readonly expected_stage: string | null,
    readonly current_stage: string,
    readonly expected_review_state: string | null,
    readonly review_state: string | null,
    readonly to_stage: string,
    readonly stage_entered_at: string | null,
    readonly recent_comments: RecentComment[],
    message: string,
  ) {
    super(message);
    this.name = "StageConflictError";
  }
}

export class ExpectedStateRequiredError extends Error {
  readonly code = "VALIDATION";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ExpectedStateRequiredError";
  }
}

export function truncateCommentBody(
  body: string,
  max: number = COMMENT_BODY_MAX,
): { body: string; truncated: boolean } {
  if (body.length <= max) return { body, truncated: false };
  return { body: `${body.slice(0, max)}...`, truncated: true };
}

export function missingExpectedStateErrors(input: {
  require: boolean;
  asHuman: boolean;
  gatedStage: boolean;
  expected_stage?: string;
  expected_review_state?: string | null;
  reviewStateProvided: boolean;
}): string[] {
  if (!input.require || input.asHuman) return [];
  const errors: string[] = [];
  if (!input.expected_stage?.trim()) {
    errors.push(MISSING_EXPECTED_STAGE);
  }
  if (input.gatedStage && !input.reviewStateProvided) {
    errors.push(MISSING_EXPECTED_REVIEW_STATE);
  }
  return errors;
}

export function throwIfMissingExpectedState(
  input: Parameters<typeof missingExpectedStateErrors>[0],
): void {
  const errors = missingExpectedStateErrors(input);
  if (errors[0]) throw new ExpectedStateRequiredError(errors[0]);
}

function normalizeReview(
  value: string | null | undefined,
): string | null {
  if (value == null || value === "") return null;
  return value;
}

function reviewLabel(value: string | null): string {
  return value ?? "none";
}

/** 409-pad: only fields that were actually set. */
export function assertExpectedState(input: {
  expected_stage?: string;
  current_stage: string;
  expected_review_state?: string | null;
  reviewStateProvided: boolean;
  current_review_state: string | null;
  to_stage: string;
  stage_entered_at?: string | null;
  recent_comments?: RecentComment[];
}): void {
  const stageGiven = Boolean(input.expected_stage?.trim());
  const reviewGiven = input.reviewStateProvided;
  if (!stageGiven && !reviewGiven) return;

  const currentReview = normalizeReview(input.current_review_state);
  const expectedReview = normalizeReview(input.expected_review_state);
  const stageMismatch =
    stageGiven && input.expected_stage!.trim() !== input.current_stage;
  const reviewMismatch = reviewGiven && expectedReview !== currentReview;
  if (!stageMismatch && !reviewMismatch) return;

  const parts: string[] = [];
  if (stageMismatch) {
    parts.push(
      `Ticket is in "${input.current_stage}", not the expected "${input.expected_stage!.trim()}". Another actor moved it.`,
    );
  }
  if (reviewMismatch) {
    parts.push(
      `Ticket review_state is "${reviewLabel(currentReview)}", not the expected "${reviewLabel(expectedReview)}". Another actor changed the verdict.`,
    );
  }

  throw new StageConflictError(
    stageGiven ? input.expected_stage!.trim() : null,
    input.current_stage,
    reviewGiven ? expectedReview : null,
    currentReview,
    input.to_stage,
    input.stage_entered_at ?? null,
    input.recent_comments ?? [],
    parts.join(" "),
  );
}

export async function loadRecentCommentsForConflict(
  load: () => Promise<
    Array<{ author?: string; createdAt: string; body: string }>
  >,
): Promise<RecentComment[]> {
  let raw: Array<{ author?: string; createdAt: string; body: string }>;
  try {
    raw = await load();
  } catch {
    return [];
  }
  return [...raw]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 2)
    .map((c) => {
      const truncated = truncateCommentBody(c.body ?? "");
      return {
        author: c.author ?? "",
        createdAt: c.createdAt,
        body: truncated.body,
        truncated: truncated.truncated,
      };
    });
}

/**
 * Full guard used by TraceService.transitionTicket before any comment or
 * field write. Throws ExpectedStateRequiredError (400) or StageConflictError
 * (409). Returns recent comments (possibly empty) when the guard passes.
 */
export async function enforceExpectedTransition(input: {
  require: boolean;
  asHuman: boolean;
  gatedStage: boolean;
  expected_stage?: string;
  expected_review_state?: string | null;
  reviewStateProvided: boolean;
  current_stage: string;
  current_review_state: string | null;
  to_stage: string;
  stage_entered_at: string | null;
  loadComments: () => Promise<
    Array<{ author?: string; createdAt: string; body: string }>
  >;
}): Promise<RecentComment[]> {
  throwIfMissingExpectedState(input);
  const recent_comments = await loadRecentCommentsForConflict(input.loadComments);
  assertExpectedState({
    expected_stage: input.expected_stage,
    current_stage: input.current_stage,
    expected_review_state: input.expected_review_state,
    reviewStateProvided: input.reviewStateProvided,
    current_review_state: input.current_review_state,
    to_stage: input.to_stage,
    stage_entered_at: input.stage_entered_at,
    recent_comments,
  });
  return recent_comments;
}
