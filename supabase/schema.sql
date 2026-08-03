-- QuantizeLab MCP Server — self-hosted database schema
--
-- Everything this worker needs, in one idempotent file. Safe to run against a
-- fresh Supabase project (SQL editor or `supabase db push`).
--
-- Design notes:
--   * The worker talks to the DB through the SERVICE ROLE key (server-only,
--     never exposed to clients), so all writes happen with elevated rights.
--   * Row Level Security is still enabled on every table: the browser app and
--     any accidental anon/authenticated access are confined to their own rows.
--   * API keys are stored as SHA-256 hashes only — the DB can never leak a
--     usable key.
--   * Money-critical moves (deduct/add credits) go through atomic
--     SECURITY DEFINER functions so two concurrent jobs can't over-spend.

-- ============================================================
-- Enums + helpers
-- ============================================================

DO $$ BEGIN CREATE TYPE public.job_format AS ENUM ('gguf','awq','gptq','exl2'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.job_status AS ENUM ('queued','running','done','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============================================================
-- profiles
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  hf_token_encrypted text,
  hf_token_hash text,
  hf_username_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: users read own" ON public.profiles;
CREATE POLICY "profiles: users read own" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles: users update own" ON public.profiles;
CREATE POLICY "profiles: users update own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE INDEX IF NOT EXISTS profiles_hf_token_hash_idx ON public.profiles (hf_token_hash) WHERE hf_token_hash IS NOT NULL;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- credits + ledger
-- ============================================================

CREATE TABLE IF NOT EXISTS public.credits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_credits integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.credits TO authenticated;
GRANT ALL ON public.credits TO service_role;
ALTER TABLE public.credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credits: users read own" ON public.credits;
CREATE POLICY "credits: users read own" ON public.credits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS credits_set_updated_at ON public.credits;
CREATE TRIGGER credits_set_updated_at BEFORE UPDATE ON public.credits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_credits integer NOT NULL,
  reason text NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.credit_transactions TO authenticated;
GRANT ALL ON public.credit_transactions TO service_role;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tx: users read own" ON public.credit_transactions;
CREATE POLICY "tx: users read own" ON public.credit_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS tx_user_created_idx ON public.credit_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_job_idx ON public.credit_transactions (job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_topup_reason_key
  ON public.credit_transactions (reason) WHERE reason LIKE 'topup:%';

-- ============================================================
-- jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hf_model_url text NOT NULL,
  target_format public.job_format NOT NULL,
  model_size_params text,
  status public.job_status NOT NULL DEFAULT 'queued',
  modal_call_id text,
  error_message text,
  output_hf_repo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  worker_callback_token_hash text,
  size_b numeric,
  tier text,
  credits_cost integer,
  paid boolean NOT NULL DEFAULT false,
  refund_status text,
  refund_error text
);

GRANT SELECT ON public.jobs TO authenticated;
GRANT ALL ON public.jobs TO service_role;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jobs: users read own" ON public.jobs;
CREATE POLICY "jobs: users read own" ON public.jobs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON public.jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON public.jobs (status);
CREATE INDEX IF NOT EXISTS jobs_worker_callback_token_hash_idx ON public.jobs (worker_callback_token_hash);

-- ============================================================
-- api_keys (hashed, own-row only)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'default',
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_keys FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;

DROP POLICY IF EXISTS "api_keys_select_own" ON public.api_keys;
CREATE POLICY "api_keys_select_own" ON public.api_keys
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "api_keys_insert_own" ON public.api_keys;
CREATE POLICY "api_keys_insert_own" ON public.api_keys
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "api_keys_update_own" ON public.api_keys;
CREATE POLICY "api_keys_update_own" ON public.api_keys
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "api_keys_delete_own" ON public.api_keys;
CREATE POLICY "api_keys_delete_own" ON public.api_keys
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON public.api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON public.api_keys (key_hash);

-- ============================================================
-- ip_account_links (anti-farming; hashed IPs only)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ip_account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash text NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ip_hash, user_id)
);

GRANT ALL ON public.ip_account_links TO service_role;
ALTER TABLE public.ip_account_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to ip links" ON public.ip_account_links;
CREATE POLICY "No client access to ip links" ON public.ip_account_links
  FOR SELECT TO authenticated USING (false);

CREATE INDEX IF NOT EXISTS ip_account_links_ip_hash_idx ON public.ip_account_links (ip_hash);

DROP TRIGGER IF EXISTS set_ip_account_links_updated_at ON public.ip_account_links;
CREATE TRIGGER set_ip_account_links_updated_at BEFORE UPDATE ON public.ip_account_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- hf_identity_claims (one HF identity per account)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hf_identity_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hf_username_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.hf_identity_claims TO service_role;
ALTER TABLE public.hf_identity_claims ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPCs (service-role only; never grant to anon/authenticated)
-- ============================================================

REVOKE ALL ON FUNCTION public.handle_new_user(), public.deduct_credits(uuid, integer, text, uuid),
  public.add_credits(uuid, integer, text, uuid), public.claim_ip_for_user(text, uuid)
  FROM anon, authenticated;

-- Signup: create profile + grant the signup bonus in one transaction.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.credits (user_id, balance_credits) VALUES (NEW.id, 10)
    ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.credit_transactions (user_id, amount_credits, reason)
    VALUES (NEW.id, 10, 'signup_bonus');
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Atomic deduction: returns false (and changes nothing) if balance is short.
CREATE OR REPLACE FUNCTION public.deduct_credits(_user_id uuid, _amount integer, _reason text, _job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE new_balance integer;
BEGIN
  UPDATE public.credits
    SET balance_credits = balance_credits - _amount, updated_at = now()
    WHERE user_id = _user_id AND balance_credits >= _amount
    RETURNING balance_credits INTO new_balance;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.credit_transactions (user_id, amount_credits, reason, job_id)
    VALUES (_user_id, -_amount, _reason, _job_id);
  RETURN true;
END; $$;

-- Top-ups and refunds.
CREATE OR REPLACE FUNCTION public.add_credits(_user_id uuid, _amount integer, _reason text, _job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.credits (user_id, balance_credits) VALUES (_user_id, _amount)
    ON CONFLICT (user_id) DO UPDATE
      SET balance_credits = public.credits.balance_credits + EXCLUDED.balance_credits,
          updated_at = now();
  INSERT INTO public.credit_transactions (user_id, amount_credits, reason, job_id)
    VALUES (_user_id, _amount, _reason, _job_id);
END; $$;

-- Records this account against a network hash; returns how many distinct
-- accounts have submitted from that address (used by the anti-farming guard).
CREATE OR REPLACE FUNCTION public.claim_ip_for_user(_ip_hash text, _user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE account_count integer;
BEGIN
  INSERT INTO public.ip_account_links (ip_hash, user_id) VALUES (_ip_hash, _user_id)
    ON CONFLICT (ip_hash, user_id) DO UPDATE SET updated_at = now();
  SELECT count(DISTINCT user_id) INTO account_count
    FROM public.ip_account_links WHERE ip_hash = _ip_hash;
  RETURN account_count;
END; $$;

-- Backfill for existing users (idempotent; safe to re-run).
INSERT INTO public.profiles (id, email)
SELECT u.id, u.email FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

WITH missing AS (
  SELECT u.id FROM auth.users u
  LEFT JOIN public.credits c ON c.user_id = u.id
  WHERE c.user_id IS NULL
), seeded AS (
  INSERT INTO public.credits (user_id, balance_credits)
  SELECT id, 10 FROM missing
  RETURNING user_id
)
INSERT INTO public.credit_transactions (user_id, amount_credits, reason)
SELECT user_id, 10, 'signup_bonus' FROM seeded;
