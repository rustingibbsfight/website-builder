export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} "${id}" not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when an optimistic-locked write loses a concurrent race — retry. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * The request was fine; this deployment cannot do that.
 *
 * Distinct from `ValidationError` because the two say opposite things to
 * whoever is on the other end. A 4xx means "change what you sent and try
 * again", and image generation with no studio configured is not fixable from
 * there at any body — a caller that retried with different words would fail
 * identically for ever, and a *model* on the far end will retry, several times,
 * rewording the brief.
 *
 * So it maps to 501, and the message names the environment variables rather
 * than saying "not configured": the person who can fix it is the one reading
 * the response, and "which switch" is the whole of what they need.
 */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}
