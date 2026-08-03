/**
 * Platform-wide GPU spend ceiling (server-only).
 *
 * Credits protect us per user, but nothing capped the aggregate: a bug, a
 * scripted attack, or one enthusiastic whale could queue hundreds of jobs in a
 * day and run the compute bill far past what the top-ups covered. This module
 * measures worst-case GPU wall-clock already committed in the current UTC day
 * and month, and refuses new dispatches once either ceiling is reached.
 *
 * Worst case, not actual: every queued/running/finished job is counted at its
 * full tier budget. That is deliberately pessimistic - the cap should trip
 * early rather than after the money is gone.
 *
 * Tune without a deploy via env: MAX_DAILY_GPU_MINUTES / MAX_MONTHLY_GPU_MINUTES.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { jobTimeoutSecondsForUrl } from "./pricing";

const DEFAULT_DAILY_MINUTES = 240; // ~4 GPU-hours/day
const DEFAULT_MONTHLY_MINUTES = 3000; // ~50 GPU-hours/month

function envMinutes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

type Row = { hf_model_url: string };

async function committedMinutes(admin: SupabaseClient, sinceIso: string): Promise<number> {
  const { data, error } = await admin
    .from("jobs")
    .select("hf_model_url")
    .gte("created_at", sinceIso)
    .neq("status", "failed")
    .limit(5000);
  if (error) {
    // Never block submissions because the meter itself is broken.
    console.error("[gpu_budget] scan failed", error);
    return 0;
  }
  const rows = (data ?? []) as Row[];
  const seconds = rows.reduce((sum, r) => sum + jobTimeoutSecondsForUrl(r.hf_model_url), 0);
  return seconds / 60;
}

export type BudgetVerdict = { blocked: false } | { blocked: true; scope: "day" | "month" };

export async function checkGpuBudget(admin: SupabaseClient): Promise<BudgetVerdict> {
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const dayUsed = await committedMinutes(admin, dayStart);
  if (dayUsed >= envMinutes("MAX_DAILY_GPU_MINUTES", DEFAULT_DAILY_MINUTES)) {
    console.warn("[gpu_budget] daily ceiling reached", { dayUsed });
    return { blocked: true, scope: "day" };
  }

  const monthUsed = await committedMinutes(admin, monthStart);
  if (monthUsed >= envMinutes("MAX_MONTHLY_GPU_MINUTES", DEFAULT_MONTHLY_MINUTES)) {
    console.warn("[gpu_budget] monthly ceiling reached", { monthUsed });
    return { blocked: true, scope: "month" };
  }

  return { blocked: false };
}
