// Server-only helpers for job + checkout server functions.
// These MUST live outside any module that declares `createServerFn`: the
// server-fn split transform deletes runtime siblings of a handler, which
// would turn these into a runtime ReferenceError.

import { fetchWithTimeout } from "./errors.server";

// In production we never surface raw provider/internal error strings to the
// browser. Log the real error server-side, return a generic message to the UI.
// Worker env is injected per-request, so a module-scope process.env read is
// The standalone worker always runs in production: never leak raw details.
const IS_PROD = true;

export function safeMessage(err: unknown, generic: string, scope: string): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  console.error(`[${scope}]`, err);
  return IS_PROD ? generic : `${generic} (${raw})`;
}

export const IMPLEMENTED_FORMATS = new Set(["gguf"]);

export function checkoutRedirectOrigin(): string {
  const raw = process.env.SITE_URL;
  if (raw) return raw.replace(/\/+$/, "");
  return "https://quantizelab.dev";
}

type WhopCheckoutInput = {
  amountDollars: number;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
};

// One code path for every Whop one-time checkout we create.
export async function createWhopCheckout(
  input: WhopCheckoutInput,
): Promise<{ ok: true; checkout_url: string } | { ok: false; message: string }> {
  const whopApiKey = process.env.WHOP_API_KEY;
  const whopAccountId = process.env.WHOP_ACCOUNT_ID;
  if (!whopApiKey || !whopAccountId) {
    return { ok: false, message: "Payments are not configured yet." };
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.whop.com/api/v1/checkout_configurations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${whopApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan: {
            company_id: whopAccountId,
            initial_price: input.amountDollars,
            currency: "usd",
            plan_type: "one_time",
            title: input.title,
            description: input.description,
            force_create_new_plan: true,
          },
          metadata: input.metadata,
          redirect_url: `${checkoutRedirectOrigin()}/dashboard?topup=1`,
        }),
      },
      15_000,
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Whop ${res.status}: ${body.slice(0, 200)}`);
    let parsed: { purchase_url?: string };
    try {
      parsed = JSON.parse(body) as { purchase_url?: string };
    } catch {
      throw new Error(`Whop returned a non-JSON body: ${body.slice(0, 120)}`);
    }
    if (!parsed.purchase_url) throw new Error("No purchase_url from Whop");
    return { ok: true, checkout_url: parsed.purchase_url };
  } catch (e) {
    return {
      ok: false,
      message: safeMessage(
        e,
        "Checkout is temporarily unavailable. Please try again in a moment.",
        "whop_checkout",
      ),
    };
  }
}
