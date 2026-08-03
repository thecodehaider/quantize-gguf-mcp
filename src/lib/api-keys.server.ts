/**
 * API key helpers for the public MCP endpoint and programmatic access.
 *
 * A key looks like `ql_` + 48 hex chars (24 random bytes). Only the SHA-256
 * hash of the full key is stored, so the table can never leak a usable key.
 * Server-only: `crypto` here is the Node/Workers global, never bundled
 * into the browser client.
 */

const KEY_PREFIX = "ql_";
const KEY_RANDOM_BYTES = 24;
export const MAX_ACTIVE_KEYS = 10;

export async function generateApiKey(): Promise<string> {
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${KEY_PREFIX}${hex}`;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function keyPrefixOf(key: string): string {
  return key.length > 11 ? `${key.slice(0, 11)}…` : key;
}

/**
 * Resolve an API key to a user. Returns null when the key is unknown,
 * revoked, or malformed. Updates `last_used_at` best-effort.
 */
export async function lookupUserByApiKey(
  supabaseAdmin: any,
  rawKey: string | null,
): Promise<{ userId: string; keyId: string } | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  const keyHash = await hashApiKey(rawKey);
  const { data, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id, revoked_at")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  // Best-effort touch; must be awaited inside a try/catch or the Workers
  // isolate freezes after the response is sent and the update never lands.
  try {
    await supabaseAdmin
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id);
  } catch (e) {
    console.error("[api_key_touch]", e);
  }
  return { userId: data.user_id, keyId: data.id };
}
