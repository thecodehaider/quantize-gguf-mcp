/**
 * Shared verification helpers for the public Modal worker callbacks.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 hex digest of a worker callback token (matches the stored column). */
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of a presented callback token against the stored
 * hash. A plain `!==` on hex digests leaks match length through timing, which
 * is enough to brute-force a token byte by byte over many requests.
 */
export function workerTokenMatches(stored: unknown, presented: string): boolean {
  if (typeof stored !== "string" || stored.length === 0) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(hashWorkerToken(presented), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
