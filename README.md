<div align="center">

# ⚡ QuantizeLab MCP Server

**Quantize, publish and share Hugging Face models as GGUF — right from your AI tools.**

Turn any Hugging Face model into a production-ready GGUF file with one tool call.
Powered by **Cloudflare Workers**, **Supabase** and **Modal**.

[![Model Context Protocol](https://img.shields.io/badge/MCP-2025--06--18-000000.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-%E2%9C%93-f38020.svg?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Supabase](https://img.shields.io/badge/Supabase-%E2%9C%93-3ecf8e.svg?logo=supabase&logoColor=white)](https://supabase.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`mcp-server` · `model-context-protocol` · `quantization` · `gguf` · `llm` · `cloudflare-workers` · `supabase`

</div>

---

## 🚀 What is this?

QuantizeLab is a **hosted model quantization service** with a Model Context
Protocol (MCP) server. It lets Claude, Cursor, and any other MCP-capable
assistant **convert Hugging Face models to GGUF format** and publish the result
to your own HF profile — without writing a single line of quantization code.

```
┌─────────────┐   MCP (Streamable HTTP)   ┌──────────────────┐   modal.com   ┌───────────────┐
│  Claude /   │ ────────────────────────▶ │  QuantizeLab MCP │ ────────────▶ │  GPU worker   │
│  Cursor / … │ ◀────────────────────────  │  (this repo)     │ ◀────────────  │  llama.cpp    │
└─────────────┘                           └──────────────────┘               └───────┬───────┘
        │                                        │                                  │
        │            JSON-RPC over HTTPS         │        HF API (token-scoped)      │
        │                                        ▼                                  ▼
        │                                ┌──────────────────┐              ┌───────────────┐
        └──────────────────────────────▶ │      Supabase    │              │  Hugging Face │
                                         │  credits/jobs/…  │              │    (GGUF)     │
                                         └──────────────────┘              └───────────────┘
```

## ✨ Features

- 🧠 **Zero-config quantization** — paste a Hugging Face URL, get a GGUF repo back
- 🛠 **5 MCP tools** — credits, pricing, model browsing, quantization, job status
- 💳 **Prepaid credits** — atomic, race-safe ledger (no surprise bills)
- 🛡 **Safety-first pipeline** — format, token, price, GPU-budget & abuse checks *before* a job starts
- 🔐 **Encrypted HF tokens** — your token never touches the client or logs
- 🚫 **Anti-farming guard** — hashed-IP account limits, paying users exempt
- 🌐 **Streamable HTTP + SSE** — works with every modern MCP client

## ⚡ Quick start (2 minutes)

1. **Create an API key** on [quantizelab.dev/developers](https://quantizelab.dev/developers) → *Create API key* → copy `ql_...` (shown once).
2. **Add the MCP server** to your client (configs below).
3. **Quantize** — ask your assistant:

   > *"Quantize `cognitivecomputations/dolphin-2.6-phi-2` to GGUF and publish it to my profile."*

4. **Verify** — call `get_job_status` until `done`, then find the new repo on your HF profile.

## 🔑 Creating an API key

1. Go to **quantizelab.dev** and sign up (new accounts get **10 free credits**).
2. Open **API & MCP** from the sidebar → **Create API key**.
3. Give it a name (e.g. `cursor`) and copy the `ql_...` value — **it is shown only once**.
4. Rotate anytime: revoke keys per-device from the same page (max **10 active**).

> Keys are stored as **SHA-256 hashes only** — even a full database leak cannot
> reveal a usable key.

## 🛠 Client setup

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "quantizelab": {
      "url": "https://quantizelab.dev/api/public/mcp",
      "headers": { "Authorization": "Bearer ql_YOUR_API_KEY" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add quantizelab \
  --transport http \
  --url https://quantizelab.dev/api/public/mcp \
  --header "Authorization: Bearer ql_YOUR_API_KEY"
```

### Cursor

Settings → **MCP** → *Add new MCP server*:

| Field | Value |
| --- | --- |
| Type | URL |
| Name | `quantizelab` |
| URL | `https://quantizelab.dev/api/public/mcp` |
| Header | `Authorization: Bearer ql_YOUR_API_KEY` |

### Any other MCP client

Point it at `https://quantizelab.dev/api/public/mcp` (Streamable HTTP /
JSON-RPC 2.0) and attach the `Authorization: Bearer ql_...` header. A plain
`GET` returns the server metadata, so most clients discover the tools
automatically.

## 🧰 Tools

| Tool | Description | Key args |
| --- | --- | --- |
| `get_credits` | Current credit balance | — |
| `get_pricing` | Tier table for a model URL | `hf_model_url` |
| `browse_model` | Inspect a HF repo (size, params, architecture, formats) | `hf_model_url` |
| `quantize_model` | Quantize + publish. **Requires `confirm: true`** | `hf_model_url`, `target_format`, `confirm` |
| `get_job_status` | Poll a submitted job | `job_id` |

### `quantize_model` — model prices & supported formats

| Tier | Model size | Credits | ≈ USD |
| --- | --- | --- | --- |
| Small | ≤ 1.1B params | 5 | $0.50 |
| Medium | ≤ 3B | 15 | $1.50 |
| Large | ≤ 8B | 35 | $3.50 |
| XL | ≤ 15B | 65 | $6.50 |

> Models **larger than 15B** are rejected before anything is charged. Only
> **GGUF** is available today; AWQ / GPTQ / EXL2 are in progress.

## 💳 Pricing & credits

- **1 credit = $0.10.** You only pay when a job actually starts (credits are
  deducted atomically; refunded automatically if dispatch fails).
- **Signup bonus: 10 free credits** — no card required.
- Top-up packs:

| Pack | Price | Credits |
| --- | --- | --- |
| Starter | $5 | 50 |
| Standard | $10 | 100 |
| Pro | $25 | 250 |
| Studio | $50 | 500 |

> Every rejection returns *all* reasons at once (`issues[]`) plus the exact
> credit shortfall and the action you need to take — never a vague error.

## ðŸ›¡ Safety pipeline (what happens on every job)

1. **Rate limit** â€” max 5 submissions per account per 60s.
2. **Format check** â€” only implemented formats are queued.
3. **HF token** â€” must be set in your dashboard; decrypted server-side only.
4. **Price check** â€” the URL must be on `huggingface.co` and â‰¤ 15B params.
5. **Preflight** â€” repo exists, files downloadable, supported architecture.
6. **Anti-farming** â€” distinct accounts per network are capped (paying users exempt).
7. **GPU budget** â€” global daily/monthly worker time caps.
8. **Balance check** â€” atomic `deduct_credits`; a short balance charges nothing.
9. **Dispatch + auto-refund** â€” if the GPU worker can't start, credits are refunded automatically.

## ðŸ” Security model

- **API keys**: SHA-256 hashed at rest; only the prefix is shown in the UI.
- **HF tokens**: AES-encrypted with a server-side secret key; never logged.
- **IP hashes**: peppered HMACs â€” raw IPs are never stored.
- **Database**: RLS enabled on every table; the worker uses the service role
  only on the server; credit moves go through `SECURITY DEFINER` functions.
- **Worker callbacks**: constant-time token verification on status updates.

## ðŸ— Self-hosting

Want to run your own instance? Everything is in this repo.

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor
   (creates tables, RLS, triggers, and the credit RPCs â€” idempotent).
3. Note your **Project URL** and **service_role** key (keep it secret!).

### 2. Deploy the worker

```bash
npm install
wrangler login
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put HF_TOKEN_ENC_KEY      # openssl rand -hex 32
npx wrangler secret put IP_HASH_PEPPER        # openssl rand -hex 32
npx wrangler deploy
```

Optional env vars: `MODAL_ENDPOINT_URL` (your Modal worker callback) and
`SITE_URL`. Update `wrangler.toml` first if you rename the worker.

### 3. Client config

Point your clients at `https://<your-worker>.workers.dev` instead of the
hosted endpoint. Everything else is identical.

## ðŸ§‘â€ðŸ’» Development

```bash
npm install
npm run typecheck   # strict TypeScript
npx wrangler deploy --dry-run   # bundle smoke test
```

## ðŸ“ Repo layout

```
src/
â”œâ”€â”€ index.ts                 # Worker entry (env, routing, auth)
â”œâ”€â”€ mcp.ts                   # JSON-RPC / Streamable HTTP / SSE core
â””â”€â”€ lib/
    â”œâ”€â”€ pricing.ts           # tiers, packs, per-URL price lookup
    â”œâ”€â”€ api-keys.server.ts   # key generation + hashing + lookup
    â”œâ”€â”€ jobs.schema.ts       # zod schemas (shared validation)
    â”œâ”€â”€ jobs.server.ts       # checkout / safety helpers
    â”œâ”€â”€ jobs.runner.server.ts# the full guarded job pipeline
    â”œâ”€â”€ hf-preflight.server.ts  # HF repo preflight checks
    â”œâ”€â”€ hf-token-crypto.server.ts # HF token encryption
    â”œâ”€â”€ ip-guard.server.ts   # anti-farming guard
    â”œâ”€â”€ gpu-budget.server.ts # global GPU time budget
    â”œâ”€â”€ modal-dispatch.server.ts  # Modal worker dispatch
    â””â”€â”€ worker-callback.server.ts # callback token verification
supabase/
â””â”€â”€ schema.sql               # full self-host schema (tables + RLS + RPCs)
```

## ðŸ“„ License

[MIT](LICENSE) â€” build on it, fork it, run your own instance.

---

<div align="center">

Made with âš¡ by [The Code Haider](https://github.com/thecodehaider)

**[quantizelab.dev](https://quantizelab.dev)** Â· Live MCP endpoint:
`https://quantizelab.dev/api/public/mcp`

</div>

