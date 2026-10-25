export type ErrorCode = "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "precondition_failed" | "too_large";

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  too_large: 413,
};

export class MantelError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (msg: string) => new MantelError("invalid", msg);
export const forbidden = (msg: string) => new MantelError("forbidden", msg);
export const notFound = (msg = "no such memory") => new MantelError("not_found", msg);
