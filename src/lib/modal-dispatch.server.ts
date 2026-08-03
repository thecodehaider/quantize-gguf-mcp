// Server-only helper: dispatch a paid job to the Modal worker.
// Extracted so both the interactive submit flow (post-webhook) and any
// retry path can call the same code.
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./errors.server";
import { hashWorkerToken } from "./worker-callback.server";
import { jobTimeoutSecondsForUrl } from "./pricing";

const DEFAULT_MODAL_ENDPOINT_URL = "https://thecodehaider--dispatch.modal.run";
const DEFAULT_PUBLIC_SITE_ORIGIN = "https://quantizelab.dev";

export function siteOrigin(): string {
  const raw = process.env.SITE_URL;
  if (raw) return raw.replace(/\/+$/, "");
  return DEFAULT_PUBLIC_SITE_ORIGIN;
}

export async function dispatchJobToModal(
  admin: SupabaseClient,
  jobId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: job, error } = await admin
    .from("jobs")
    .select("id, user_id, hf_model_url, target_format, status, paid")
    .eq("id", jobId)
    .maybeSingle();
  if (error || !job) return { ok: false, error: error?.message ?? "job not found" };
  if (job.status === "running" || job.status === "done") return { ok: true };

  const { data: profile } = await admin
    .from("profiles")
    .select("hf_token_encrypted")
    .eq("id", job.user_id)
    .maybeSingle();
  if (!profile?.hf_token_encrypted) {
    await admin
      .from("jobs")
      .update({
        status: "failed",
        error_message: "HF token missing at dispatch time - reconnect in Settings.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    return { ok: false, error: "hf token missing" };
  }

  const { decryptHfToken } = await import("./hf-token-crypto.server");
  let hfToken: string;
  try {
    hfToken = decryptHfToken(profile.hf_token_encrypted);
  } catch {
    await admin
      .from("jobs")
      .update({
        status: "failed",
        error_message: "Stored HF token could not be decrypted.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    return { ok: false, error: "hf token unreadable" };
  }

  const callbackToken = randomBytes(32).toString("hex");
  const { error: tokenErr } = await admin
    .from("jobs")
    .update({ worker_callback_token_hash: hashWorkerToken(callbackToken) })
    .eq("id", jobId);
  if (tokenErr) {
    console.error("[modal_dispatch_token]", tokenErr);
    return { ok: false, error: "could not prepare job callback" };
  }

  const endpoint = process.env.MODAL_ENDPOINT_URL || DEFAULT_MODAL_ENDPOINT_URL;
  const origin = siteOrigin();
  const callbackUrl = `${origin}/api/public/jobs/${jobId}/complete`;
  const authorizationUrl = `${origin}/api/public/jobs/${jobId}/authorize`;

  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          hf_model_url: job.hf_model_url,
          target_format: job.target_format,
          hf_token: hfToken,
          callback_url: callbackUrl,
          authorization_url: authorizationUrl,
          callback_token: callbackToken,
          // Per-tier GPU budget: small models die fast, 8B/14B get the room they
          // actually need instead of failing on a one-size-fits-all 5min wall.
          timeout_s: jobTimeoutSecondsForUrl(job.hf_model_url),
        }),
      },
      20_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Modal dispatch ${res.status}: ${body.slice(0, 200)}`);
    }
    const modalRes = (await res.json().catch(() => ({}))) as { modal_call_id?: string };
    const { error: runErr } = await admin
      .from("jobs")
      .update({ status: "running", modal_call_id: modalRes.modal_call_id ?? null })
      .eq("id", jobId);
    if (runErr) console.error("[modal_dispatch_status]", { jobId, runErr });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Dispatch failed";
    console.error("[modal_dispatch]", { jobId, error: e });
    const { error: failErr } = await admin
      .from("jobs")
      .update({
        status: "failed",
        error_message: msg.slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (failErr) console.error("[modal_dispatch_fail_mark]", { jobId, failErr });
    return { ok: false, error: msg };
  }
}
