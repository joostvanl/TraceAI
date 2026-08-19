/** TraceAI domain errors. HTTP status is a field, never inferred from `message`. */

export class TraceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "TraceError";
  }
}

export class NotFoundError extends TraceError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends TraceError {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message, 400, "VALIDATION");
    this.name = "ValidationError";
  }
}

export class ForbiddenError extends TraceError {
  constructor(message: string) {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export function assertNoErrors(errors: string[]): void {
  if (errors.length) {
    throw new ValidationError(errors.join(" "), errors);
  }
}
