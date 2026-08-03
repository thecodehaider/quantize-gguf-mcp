/**
 * Network-level anti-farming guard.
 *
 * Fresh accounts get free signup credits, so one person could otherwise sign up
 * repeatedly for unlimited free jobs. This caps how many distinct free accounts
 * may run jobs from one network address. Raw IPs are never stored - only a
 * peppered HMAC - and paying accounts are exempt so shared office/campus
 * networks don't punish customers.
 */
import { createHmac } from "node:crypto";

// Max distinct accounts allowed to submit jobs from the same network address
// while still spending free (never-topped-up) credits.
export const MAX_FREE_ACCOUNTS_PER_IP = 3;

/**
 * One-way hash of the caller's IP from a Worker request. We never store or log
 * the raw address. Peppered with a server-only secret so the hashes aren't
 * reversible via a rainbow table of the IPv4 space.
 */
export function hashRequestIp(request: Request): string | null {
  const pepper = process.env.IP_HASH_PEPPER;
  if (!pepper) return null;

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    null;
  if (!ip) return null;

  return createHmac("sha256", pepper).update(ip.trim().toLowerCase()).digest("hex");
}

type AdminClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  from: (table: string) => any;
};

/**
 * Records this account against the caller's network hash and decides whether
 * the submission should be blocked as free-credit farming.
 *
 * Accounts that have ever paid (top-up in their ledger) are exempt: a shared
 * office or campus network shouldn't punish paying customers.
 */
export async function checkIpAbuse(
  supabaseAdmin: AdminClient,
  userId: string,
  request?: Request,
): Promise<{ blocked: boolean }> {
  const ipHash = request ? hashRequestIp(request) : null;
  if (!ipHash) return { blocked: false };

  const { data: paid } = await supabaseAdmin
    .from("credit_transactions")
    .select("id")
    .eq("user_id", userId)
    .like("reason", "topup%")
    .limit(1);
  const hasPaid = Array.isArray(paid) && paid.length > 0;

  const { data: count, error } = await supabaseAdmin.rpc("claim_ip_for_user", {
    _ip_hash: ipHash,
    _user_id: userId,
  });
  if (error) {
    console.error("[ip_guard]", error);
    return { blocked: false };
  }
  if (hasPaid) return { blocked: false };

  return { blocked: Number(count ?? 0) > MAX_FREE_ACCOUNTS_PER_IP };
}
