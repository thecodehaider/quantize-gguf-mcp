// Top-up credit pricing. 1 credit = $0.10.
// Users buy fixed credit packs via Whop; jobs deduct credits upfront and
// refund them if Modal fails. Nothing is charged per-job on a card.

export const MAX_MODEL_B = 15;
export const DOLLARS_PER_CREDIT = 0.1;
export const SIGNUP_BONUS_CREDITS = 10;

/** Days an email is barred from creating a new account after self-deletion. */
export const RESIGNUP_COOLDOWN_DAYS = 7;

export type Tier = {
  id: "1b" | "3b" | "8b" | "14b";
  label: string;
  maxB: number;
  credits: number;
  // Estimated Modal GPU cost per job in credits (for admin margin math only).
  costCredits: number;
  // Hard GPU wall-clock budget for one job of this tier, in seconds. Bigger
  // models legitimately need longer to download + convert + quantize; smaller
  // ones must die fast so a hung job can't burn the balance.
  timeoutS: number;
};

// Order matters: first tier where size <= maxB wins.
export const TIERS: Tier[] = [
  { id: "1b", label: "≤ 1.1B", maxB: 1.1, credits: 5, costCredits: 1, timeoutS: 5 * 60 },
  { id: "3b", label: "≤ 3B", maxB: 3, credits: 15, costCredits: 2, timeoutS: 6 * 60 },
  { id: "8b", label: "≤ 8B", maxB: 8, credits: 35, costCredits: 6, timeoutS: 12 * 60 },
  // Top tier extends to the MAX_MODEL_B ceiling so every accepted size is priceable.
  { id: "14b", label: "≤ 15B", maxB: MAX_MODEL_B, credits: 65, costCredits: 15, timeoutS: 15 * 60 },
];

// Absolute ceiling enforced on both sides (app + worker) so a bad payload can
// never ask for an unbounded GPU window.
export const MAX_JOB_TIMEOUT_S = 15 * 60;
export const DEFAULT_JOB_TIMEOUT_S = 5 * 60;

/** Wall-clock GPU budget for a job, derived from the model URL's size marker. */
export function jobTimeoutSecondsForUrl(hfUrl: string): number {
  const sizeB = parseSizeBFromRepo(hfUrl);
  const tier = sizeB === null ? null : pickTier(sizeB);
  return Math.min(tier?.timeoutS ?? DEFAULT_JOB_TIMEOUT_S, MAX_JOB_TIMEOUT_S);
}

// Fixed Whop credit packs. `credits` is added to the user's balance on
// payment.succeeded. `priceDollars` is what Whop actually charges.
export type Pack = {
  id: "starter5" | "starter10" | "pro25" | "enterprise50";
  label: string;
  priceDollars: number;
  credits: number;
  blurb: string;
};

export const PACKS: Pack[] = [
  { id: "starter5", label: "Starter", priceDollars: 5, credits: 50, blurb: "Kick the tyres." },
  {
    id: "starter10",
    label: "Standard",
    priceDollars: 10,
    credits: 100,
    blurb: "~5-7 small quantizations.",
  },
  {
    id: "pro25",
    label: "Pro",
    priceDollars: 25,
    credits: 250,
    blurb: "~15-20 medium quantizations.",
  },
  {
    id: "enterprise50",
    label: "Studio",
    priceDollars: 50,
    credits: 500,
    blurb: "~35-45 large quantizations.",
  },
];

export function findPack(id: string): Pack | null {
  return PACKS.find((p) => p.id === id) ?? null;
}

/**
 * Best-effort parse of "how many billion parameters" from an HF repo name.
 * Handles patterns like `Llama-3-8B`, `Qwen2.5-1.5B-Instruct`, `TinyLlama-1.1B`,
 * `Mistral-7b-v0.1`. Returns null when no size marker is found.
 */
export function parseSizeBFromRepo(hfUrl: string): number | null {
  const name = (() => {
    try {
      return new URL(hfUrl).pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return hfUrl;
    }
  })();
  // Match a number (optionally decimal) directly followed by B/b and a
  // non-word char boundary - e.g. `-8B-`, `_1.5b_`, `.7B.`, end of string.
  const re = /(\d+(?:\.\d+)?)\s*[Bb](?=[^A-Za-z0-9]|$)/g;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 1000) {
      // Prefer the largest match - repo names occasionally embed version
      // numbers like `v0.1` that fluke-match, but the real size marker
      // is almost always the biggest number that appears with a B suffix.
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

export function pickTier(sizeB: number): Tier | null {
  for (const t of TIERS) if (sizeB <= t.maxB) return t;
  return null;
}

export function priceModelUrl(
  hfUrl: string,
): { ok: true; sizeB: number; tier: Tier } | { ok: false; sizeB: number | null; reason: string } {
  const sizeB = parseSizeBFromRepo(hfUrl);
  if (sizeB === null) {
    return {
      ok: false,
      sizeB: null,
      reason: "Couldn't detect the model size from the repo name (looking for e.g. `-8B`).",
    };
  }
  if (sizeB > MAX_MODEL_B) {
    return {
      ok: false,
      sizeB,
      reason: `Models larger than ${MAX_MODEL_B}B aren't supported yet.`,
    };
  }
  const tier = pickTier(sizeB);
  if (!tier) {
    return { ok: false, sizeB, reason: "No pricing tier matches this size." };
  }
  return { ok: true, sizeB, tier };
}
