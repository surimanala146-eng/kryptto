/**
 * Domain error carrying an HTTP status, a stable machine-readable code and
 * optional details. The global exception filter renders these as
 * `{ error: { code, message, details } }` — the envelope terminal frontends
 * (e.g. OpenCharts' request wrapper) already understand.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: Record<string, unknown>) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message: string, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static unprocessable(message: string, code = 'UNPROCESSABLE', details?: Record<string, unknown>) {
    return new ApiError(422, code, message, details);
  }
}
