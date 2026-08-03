// Server-only error helpers.
const GENERIC_ERROR = "Something went wrong. Please try again.";

// The standalone worker always runs in production: never leak raw details to
// callers. (Dev-only debugging is handled by wrangler logs.)
const IS_PROD = true;

/**
 * Log the real cause server-side and return an Error that is safe to throw
 * across the RPC boundary. In dev the raw detail is appended for debugging.
 */
export function serverError(err: unknown, scope: string, generic: string = GENERIC_ERROR): Error {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  console.error(`[${scope}]`, err);
  return new Error(IS_PROD ? generic : `${generic} (${scope}: ${raw})`);
}

/** fetch() with a hard timeout so a hung upstream can't hang the worker. */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) {
      throw new Error(`Upstream request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
