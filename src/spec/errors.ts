export class BacktestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path = '',
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BacktestError';
  }
  toJSON() {
    return { code: this.code, message: this.message, path: this.path, details: this.details, retryable: false };
  }
}

export function assertThat(condition: unknown, code: string, message: string, path = '', details: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new BacktestError(code, message, path, details);
}

export function errorJSON(error: unknown): ReturnType<BacktestError['toJSON']> {
  return error instanceof BacktestError ? error.toJSON() : new BacktestError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error)).toJSON();
}
