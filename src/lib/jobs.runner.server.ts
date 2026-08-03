/**
 * Shared credit-based job submission pipeline, used by both the web
 * dashboard (session-authenticated) and the public MCP server (API-key
 * authenticated). One pipeline, one set of guarantees:
 *
 *   rate limit -> format check -> HF token present -> price the model ->
 *   HF preflight -> abuse guard -> GPU budget ceiling -> balance check ->
 *   insert job row -> deduct credits (atomic) -> dispatch to Modal
 *   (refund on dispatch failure; the worker callback refunds on failure).
 *
 * `source` is recorded for observability (web / mcp).
 */
import { priceModelUrl } from "./pricing";
import { createJobSchema, type CreateJobInput } from "./jobs.schema";
import { IMPLEMENTED_FORMATS, safeMessage } from "./jobs.server";

export type CreateJobResult =
  | {
      ok: true;
      job_id: string;
      tier: string;
      size_b: number;
      credits_charged: number;
    }
  | {
      ok: false;
      message: string;
      /** Every rejection reason, so callers (and AIs) see the full picture. */
      issues?: string[];
      action?: "settings" | "topup";
      needed?: number;
      balance?: number;
      preview?: { sizeB: number; tierId: string; tierLabel: string; credits: number };
    };

export async function runCreateJob(args: {
  supabaseAdmin: any;
  userId: string;
  hfModelUrl: string;
  targetFormat: CreateJobInput["target_format"];
  source: "web" | "mcp";
  request?: Request;
}): Promise<CreateJobResult> {
  const { supabaseAdmin, userId, source } = args;
  const data = createJobSchema.parse({ hf_model_url: args.hfModelUrl, target_format: args.targetFormat });

  // Collect every rejection reason instead of short-circuiting on the first,
  // so clients (and MCP agents) can act on the whole picture at once.
  const issues: string[] = [];
  let action: "settings" | "topup" | undefined;
  let needed: number | undefined;
  let balance = 0;

  // Rate limit: max 5 job submissions per user per rolling 60 seconds.
  const rlWindow = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount, error: rlError } = await supabaseAdmin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", rlWindow);
  if (rlError) {
    console.error("[job_ratelimit]", rlError);
    issues.push("We couldn't check your recent jobs. Please try again.");
  } else if ((recentCount ?? 0) >= 5) {
    issues.push("You're submitting too fast - wait a minute and try again.");
  }

  if (!IMPLEMENTED_FORMATS.has(data.target_format)) {
    issues.push(`${data.target_format.toUpperCase()} is not available yet - GGUF only for now.`);
  }

  // Profile read failure is an infrastructure error: nothing further can be
  // validated, so it short-circuits (unlike a missing token, which is just
  // one more issue among many).
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("hf_token_encrypted")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) {
    return {
      ok: false,
      message: safeMessage(profileError, "We couldn't read your profile. Please try again.", "job_profile"),
    };
  }

  let hfToken: string | null = null;
  if (!profile?.hf_token_encrypted) {
    issues.push("Connect your Hugging Face token in Account settings first.");
    action = "settings";
  } else {
    try {
      const { decryptHfToken } = await import("./hf-token-crypto.server");
      hfToken = decryptHfToken(profile.hf_token_encrypted);
    } catch (e) {
      console.error("[job_preflight_token]", e);
      issues.push("We couldn't read your stored Hugging Face token. Please reconnect it in Account settings.");
      action = "settings";
    }
  }

  const priced = priceModelUrl(data.hf_model_url);
  if (!priced.ok) {
    issues.push(priced.reason);
  } else if (hfToken) {
    // Preflight the repo against the HF Hub; only meaningful with a token.
    const { preflightGgufSource } = await import("./hf-preflight.server");
    const pre = await preflightGgufSource(data.hf_model_url, hfToken);
    if (!pre.ok) issues.push(pre.message);
  }

  // Anti-farming abuse guard (best-effort, never blocks on errors).
  try {
    const { checkIpAbuse } = await import("./ip-guard.server");
    const blocked = (await checkIpAbuse(supabaseAdmin, userId, args.request)).blocked;
    if (blocked) {
      issues.push("Too many free accounts have run jobs from this network. Top up any amount to keep going.");
      action = "topup";
    }
  } catch (e) {
    console.error("[job_ip_guard]", e);
  }

  // Platform-wide compute ceiling.
  try {
    const { checkGpuBudget } = await import("./gpu-budget.server");
    const verdict = await checkGpuBudget(supabaseAdmin);
    if (verdict.blocked) {
      issues.push(
        verdict.scope === "day"
          ? "We've hit today's compute ceiling. Queueing reopens after 00:00 UTC - your credits are untouched."
          : "We've hit this month's compute ceiling. Please email support@quantizelab.dev - your credits are untouched.",
      );
    }
  } catch (e) {
    console.error("[job_gpu_budget]", e);
  }

  // Pre-check balance for a clean UX message before creating the job row.
  // Only meaningful when the model was priceable.
  if (priced.ok) {
    const cost = priced.tier.credits;
    const { data: bal, error: balError } = await supabaseAdmin
      .from("credits")
      .select("balance_credits")
      .eq("user_id", userId)
      .maybeSingle();
    if (balError) {
      console.error("[job_balance]", balError);
      issues.push("We couldn't read your credit balance. Please try again.");
    } else {
      balance = bal?.balance_credits ?? 0;
      if (balance < cost) {
        issues.push(`You need ${cost} credits for this ${priced.tier.label} model. Balance: ${balance}.`);
        needed = cost;
        action = "topup";
      }
    }
  }

  // Surface every reason together; the caller decides what to show.
  if (issues.length > 0) {
    return { ok: false, message: issues.join(" "), issues, action, needed, balance };
  }

  // Everything validated: proceed with job creation. `priced` is guaranteed
  // ok here (a pricing failure would have pushed an issue above).
  if (!priced.ok) return { ok: false, message: priced.reason };
  const cost = priced.tier.credits;

  // Insert queued job row.
  const { data: job, error: insertErr } = await supabaseAdmin
    .from("jobs")
    .insert({
      user_id: userId,
      hf_model_url: data.hf_model_url,
      target_format: data.target_format,
      status: "queued",
      size_b: priced.sizeB,
      tier: priced.tier.id,
      credits_cost: cost,
      paid: true,
    } as any)
    .select("id")
    .single();
  if (insertErr || !job) {
    return {
      ok: false,
      message: safeMessage(insertErr, "We couldn't queue your job. Please try again.", "job_insert"),
    };
  }

  // Atomic deduction via SECURITY DEFINER RPC.
  const { data: deducted, error: dedErr } = await supabaseAdmin.rpc("deduct_credits", {
    _user_id: userId,
    _amount: cost,
    _reason: "job_hold",
    _job_id: job.id,
  });
  if (dedErr || !deducted) {
    await supabaseAdmin.from("jobs").delete().eq("id", job.id);
    if (dedErr) {
      return {
        ok: false,
        message: safeMessage(dedErr, "We couldn't reserve your credits. Please try again.", "credit_deduct"),
      };
    }
    return {
      ok: false,
      action: "topup",
      message: `Not enough credits. Top up to continue.`,
      needed: cost,
      balance: balance ?? 0,
    };
  }

  // Dispatch to Modal.
  let dispatch: { ok: true } | { ok: false; error: string };
  try {
    const { dispatchJobToModal } = await import("./modal-dispatch.server");
    dispatch = await dispatchJobToModal(supabaseAdmin, job.id);
  } catch (e) {
    dispatch = { ok: false, error: e instanceof Error ? e.message : "dispatch crashed" };
  }
  if (!dispatch.ok) {
    const { error: refundErr } = await supabaseAdmin.rpc("add_credits", {
      _user_id: userId,
      _amount: cost,
      _reason: "dispatch_refund",
      _job_id: job.id,
    });
    if (refundErr)
      console.error("[job_dispatch_refund_failed]", { job_id: job.id, userId, cost, refundErr });
    const { error: markErr } = await supabaseAdmin
      .from("jobs")
      .update({
        status: "failed",
        error_message: "Dispatch to the quantization worker failed.",
        completed_at: new Date().toISOString(),
        refund_status: refundErr ? "refund_failed" : "credits_refunded",
      } as any)
      .eq("id", job.id);
    if (markErr) console.error("[job_dispatch_mark_failed]", { job_id: job.id, markErr });
    return {
      ok: false,
      message: safeMessage(
        dispatch.error,
        "We couldn't start your job right now. Your credits have been refunded, please try again.",
        "dispatch",
      ),
    };
  }

  if (source === "mcp") console.log("[mcp_job_created]", { job_id: job.id, userId });
  return {
    ok: true,
    job_id: job.id,
    tier: priced.tier.id,
    size_b: priced.sizeB,
    credits_charged: cost,
  };
}
