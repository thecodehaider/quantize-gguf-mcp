# QuantizeLab MCP Server

**Quantize and publish Hugging Face models as GGUF — from any MCP-capable AI assistant.**

This directory describes the hosted QuantizeLab MCP server. The server itself is
operated by QuantizeLab at `https://quantizelab.dev/api/public/mcp`. Anyone with a
QuantizeLab account can connect to it for free from their own machine — Claude,
Cursor, or any MCP client. There is no self-hosted edition: the service runs on our
side only.

- Live endpoint: `https://quantizelab.dev/api/public/mcp`
- Models: up to **33B parameters**, GGUF (Q4_K_M) only
- Pricing: previewed in credits before anything runs; failed jobs refund automatically
- Confirmation is mandatory — the AI can suggest, you decide

## Quick start

1. Sign up at [quantizelab.dev](https://quantizelab.dev) — new accounts get 10 free credits.
2. Open **API & MCP** from the sidebar and create an API key (`ql_...`). It is shown once, so keep it safe.
3. Add the server to your client (configs below).
4. Ask your assistant: *"Quantize `cognitivecomputations/dolphin-2.6-phi-2` to Q4_K_M and publish it to my profile."*

## Client setup

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

Settings -> MCP -> Add new MCP server:

| Field | Value |
| --- | --- |
| Type | URL |
| Name | `quantizelab` |
| URL | `https://quantizelab.dev/api/public/mcp` |
| Header | `Authorization: Bearer ql_YOUR_API_KEY` |

### Any other MCP client

Point it at `https://quantizelab.dev/api/public/mcp` (Streamable HTTP / JSON-RPC 2.0)
with the `Authorization: Bearer ql_...` header. A plain `GET` returns server metadata,
so most clients discover the tools automatically.

### Direct from the terminal (no AI)

MCP is plain JSON-RPC over HTTP — drive it with curl or any script. Initialize once per
session, then call tools:

```bash
curl -X POST https://quantizelab.dev/api/public/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ql_YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"terminal","version":"1.0"}}}'

# then call a tool, e.g. balance
curl -X POST https://quantizelab.dev/api/public/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ql_YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_credits","arguments":{}}}'
```

If a call returns "not initialized", send `{"jsonrpc":"2.0","method":"notifications/initialized"}` first.

## Tools

| Tool | Description | Key args |
| --- | --- | --- |
| `get_credits` | Current credit balance | — |
| `get_pricing` | Tier table and credit packs | — |
| `browse_model` | Price an HF repo URL without starting anything | `hf_model_url` |
| `quantize_model` | Quantize + publish — **requires `confirm: true`** | `hf_model_url`, `target_format`, `confirm` |
| `get_job_status` | Poll a submitted job | `job_id` |

## Pricing (1 credit = $0.10)

| Tier | Model size | Credits | USD |
| --- | --- | --- | --- |
| 1B | <=1.1B | 5 | $0.50 |
| 3B | <=3B | 8 | $0.80 |
| 8B | <=8B | 12 | $1.20 |
| 15B | <=15B | 15 | $1.50 |
| 33B | <=33B | 22 | $2.20 |

- Models **larger than 33B** are rejected before anything is charged.
- Top-up packs: Starter $5 = 50 cr / Standard $10 = 100 cr / Pro $25 = 250 cr / Studio $50 = 500 cr.
- Credits are deducted only when a job actually starts and are refunded automatically if dispatch fails.

## Safety (enforced server-side)

- `quantize_model` returns a cost preview first; only a second call with `confirm: true` queues the job.
- Every run goes through the same pipeline as the website: rate limit, HF token check, model preflight, abuse guard, GPU budget, atomic credit deduction, automatic refund on failure. An API key cannot bypass any of it.
- Your Hugging Face token is stored encrypted server-side and never touches the client.
- Keys are stored as one-way hashes — revoke any key from the API & MCP page and it stops working immediately.

## Hosted and operated by QuantizeLab

The MCP server is part of the QuantizeLab service and is not released for
self-hosting. Connect to the hosted endpoint — it is free for personal use.

## License

[MIT](LICENSE)