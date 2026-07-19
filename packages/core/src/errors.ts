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
