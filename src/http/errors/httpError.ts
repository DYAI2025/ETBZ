/**
 * Transport-level error with an explicit, client-safe error code.
 * Messages carried here are authored constants - never interpolated
 * configuration values or environment content.
 */
export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
  };
}
