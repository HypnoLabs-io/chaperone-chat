/**
 * The package's one error type. Every entry bundles its own copy, so code that receives an error checks it with
 * `isChaperoneError` (by shape), never with `instanceof`.
 */
export class ChaperoneError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ChaperoneError";
    this.code = code;
  }
}

/** The names the package's errors carry: `ChaperoneError`, and `JevError` for a failed Jev call. */
const NAMES = new Set(["ChaperoneError", "JevError"]);

/** True for an error this package threw, from any entry; with `code`, only that one. */
export function isChaperoneError(error: unknown, code?: string): error is ChaperoneError {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown };
  return typeof e.name === "string" && NAMES.has(e.name) && typeof e.code === "string" && (code === undefined || e.code === code);
}
