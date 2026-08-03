/**
 * Public MCP (Model Context Protocol) server — Streamable HTTP transport.
 *
 * Lets AI assistants (Claude Desktop, Claude Code, Cursor, …) use
 * QuantizeLab through tools. Authenticated with an API key from the
 * dashboard (`Authorization: Bearer ql_…`).
 *
 * Safety rules (enforced server-side, never trusted to the AI):
 *  - `quantize_model` returns a cost preview unless `confirm: true` is
 *    passed — a GPU job is only created on an explicit confirmed call.
 *  - Every confirmed run goes through the same pipeline as the web
 *    dashboard (rate limit, HF token check, price, preflight, abuse guard,
 *    GPU budget, atomic credit deduction, Modal dispatch) — see
 *    `runCreateJob` in jobs.runner.server.ts.
 *
 * Protocol: JSON-RPC 2.0 over Streamable HTTP (single response per
 * request; SSE when the client asks for text/event-stream).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TIERS, PACKS, MAX_MODEL_B, DOLLARS_PER_CREDIT, priceModelUrl } from "./lib/pricing";

const SERVER_INFO = { name: "quantizelab", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

type McpRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: any };

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function textContent(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

const TOOLS = [
  {
    name: "get_credits",
    description:
      "Returns the caller's QuantizeLab credit balance. 1 credit = $0.10. Credits are deducted only when a quantization job actually starts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_pricing",
    description:
      "Returns current QuantizeLab pricing: model size tiers in credits (5/15/35/65 credits up to 15B params), credit packs in dollars, and the max supported model size.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browse_model",
    description:
      "Checks a Hugging Face model URL: which pricing tier it lands in and how many credits a quantization would cost. Does NOT start a job and never touches credits.",
    inputSchema: {
      type: "object",
      properties: {
        hf_model_url: { type: "string", description: "Full https://huggingface.co/... model URL" },
      },
      required: ["hf_model_url"],
      additionalProperties: false,
    },
  },
  {
    name: "quantize_model",
    description:
      "Submits a GPU quantization job. IMPORTANT SAFETY RULE: call with confirm=false (or omit it) first to get a cost preview; the job is NOT started and no credits move. Only a second call with confirm=true actually queues the job and deducts credits. The model must be a GGUF-convertible, non-gated Hugging Face repo up to 15B params, and the user must have a Hugging Face token connected in their account settings. Failed jobs are refunded automatically.",
    inputSchema: {
      type: "object",
      properties: {
        hf_model_url: { type: "string", description: "Full https://huggingface.co/... model URL" },
        target_format: { type: "string", enum: ["gguf"], default: "gguf", description: "Output format (GGUF is the only format currently supported)" },
        confirm: { type: "boolean", default: false, description: "Must be true to actually start the job and charge credits" },
      },
      required: ["hf_model_url"],
      additionalProperties: false,
    },
  },
  {
    name: "get_job_status",
    description:
      "Returns the status of one of the caller's quantization jobs: queued/running/done/failed/refunded, credits charged, output repo, and error message if any.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job UUID returned by quantize_model" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
];

function sseResponse(obj: unknown): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

async function handleMcpRequest(
  body: unknown,
  authHeader: string | null,
  acceptsSse: boolean,
  supabaseAdmin: SupabaseClient,
  request?: Request,
): Promise<Response> {
  // Parse the JSON-RPC envelope.
  const req: McpRequest =
    typeof body === "object" && body !== null ? (body as McpRequest) : { method: undefined };
  const id = req.id ?? null;
  const method = typeof req.method === "string" ? req.method : "";

  // initialize is allowed before auth so clients can inspect the server.
  if (method === "initialize") {
    const caps = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
    const result = {
      protocolVersion:
        typeof caps.protocolVersion === "string" && caps.protocolVersion.startsWith("2025-")
          ? caps.protocolVersion
          : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        "QuantizeLab tools. Always call quantize_model with confirm=false first for a cost preview; never start a job without an explicit user confirmation that it costs credits.",
    };
    return acceptsSse ? sseResponse(jsonRpcResult(id, result)) : Response.json(jsonRpcResult(id, result));
  }

  // Everything else needs a valid API key.
  const { lookupUserByApiKey } = await import("./lib/api-keys.server");
  const apiKey =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const owner = await lookupUserByApiKey(supabaseAdmin, apiKey);
  if (!owner) {
    const err = jsonRpcError(id, -32001, "Unauthorized: a valid QuantizeLab API key is required (Authorization: Bearer ql_...). Generate one in the dashboard.");
    return new Response(JSON.stringify(err), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  if (method === "ping") {
    return acceptsSse ? sseResponse(jsonRpcResult(id, {})) : Response.json(jsonRpcResult(id, {}));
  }

  if (method === "tools/list") {
    const result = { tools: TOOLS };
    return acceptsSse ? sseResponse(jsonRpcResult(id, result)) : Response.json(jsonRpcResult(id, result));
  }

  if (method === "tools/call") {
    const name = typeof req.params?.name === "string" ? req.params.name : "";
    const args = req.params?.arguments && typeof req.params.arguments === "object" ? req.params.arguments : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      const err = jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      return acceptsSse ? sseResponse(err) : Response.json(err);
    }

    let result: unknown;
    try {
      result = await dispatchTool(owner.userId, name, args, supabaseAdmin, request);
    } catch (e) {
      console.error("[mcp_tool_error]", { tool: name, err: e });
      result = textContent(
        `The tool failed internally: ${e instanceof Error ? e.message : "unknown error"}. No credits were charged.`,
        true,
      );
    }
    return acceptsSse ? sseResponse(jsonRpcResult(id, result)) : Response.json(jsonRpcResult(id, result));
  }

  // Unknown method → JSON-RPC error.
  const err = jsonRpcError(id, -32601, `Method not found: ${method}`);
  return acceptsSse ? sseResponse(err) : Response.json(err);
}

async function dispatchTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  supabaseAdmin: SupabaseClient,
  request?: Request,
) {

  if (name === "get_credits") {
    const { data, error } = await supabaseAdmin
      .from("credits")
      .select("balance_credits")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    const balance = data?.balance_credits ?? 0;
    return textContent(
      JSON.stringify(
        {
          balance_credits: balance,
          balance_dollars: +(balance * DOLLARS_PER_CREDIT).toFixed(2),
          note: "Credits are deducted only when a job actually starts and are refunded if the job fails.",
        },
        null,
        2,
      ),
    );
  }

  if (name === "get_pricing") {
    return textContent(
      JSON.stringify(
        {
          max_model_b: MAX_MODEL_B,
          dollars_per_credit: DOLLARS_PER_CREDIT,
          tiers: TIERS.map((t) => ({ tier: t.id, label: t.label, credits: t.credits })),
          packs: PACKS.map((p) => ({ id: p.id, label: p.label, price_dollars: p.priceDollars, credits: p.credits })),
          note: "Models larger than 15B params are not supported.",
        },
        null,
        2,
      ),
    );
  }

  if (name === "browse_model") {
    const url = typeof args.hf_model_url === "string" ? args.hf_model_url : "";
    if (!url) return textContent("Missing hf_model_url.", true);
    const priced = priceModelUrl(url);
    if (!priced.ok) return textContent(priced.reason, true);
    return textContent(
      JSON.stringify(
        {
          model_url: url,
          size_b: priced.sizeB,
          tier: priced.tier.id,
          tier_label: priced.tier.label,
          credits_required: priced.tier.credits,
          cost_dollars: +(priced.tier.credits * DOLLARS_PER_CREDIT).toFixed(2),
          note: "Preview only - no job was started and no credits were deducted. Call quantize_model with confirm=true to actually run this.",
        },
        null,
        2,
      ),
    );
  }

  if (name === "quantize_model") {
    const url = typeof args.hf_model_url === "string" ? args.hf_model_url : "";
    const format = typeof args.target_format === "string" ? args.target_format : "gguf";
    const confirm = args.confirm === true;

    const priced = priceModelUrl(url);

    // Preview path: needs a priceable model; anything else is a bare reason.
    if (!confirm) {
      if (!priced.ok) return textContent(priced.reason, true);
      return textContent(
        JSON.stringify(
          {
            preview: {
              model_url: url,
              size_b: priced.sizeB,
              tier: priced.tier.id,
              tier_label: priced.tier.label,
              credits_required: priced.tier.credits,
              cost_dollars: +(priced.tier.credits * DOLLARS_PER_CREDIT).toFixed(2),
            },
            status: "not_started",
            instructions:
              "No job was created and no credits were deducted. Confirm with the user that they accept the credit cost, then call quantize_model again with confirm=true.",
          },
          null,
          2,
        ),
      );
    }

    const { runCreateJob } = await import("./lib/jobs.runner.server");
    const result = await runCreateJob({
      supabaseAdmin,
      userId,
      hfModelUrl: url,
      targetFormat: format as "gguf",
      source: "mcp",
      request,
    });

    if (!result.ok) {
      return textContent(
        JSON.stringify(
          {
            status: "failed",
            message: result.message,
            issues: result.issues && result.issues.length > 0 ? result.issues : [result.message],
            action: result.action ?? null,
            needed_credits: result.needed ?? null,
            balance_credits: result.balance ?? null,
            note: "No credits were charged on failure.",
          },
          null,
          2,
        ),
        true,
      );
    }

    return textContent(
      JSON.stringify(
        {
          status: "queued",
          job_id: result.job_id,
          tier: result.tier,
          size_b: result.size_b,
          credits_charged: result.credits_charged,
          next: "Track it with get_job_status. Output lands in your own Hugging Face repo. Refunds are automatic on failure.",
        },
        null,
        2,
      ),
    );
  }

  if (name === "get_job_status") {
    const jobId = typeof args.job_id === "string" ? args.job_id : "";
    if (!jobId) return textContent("Missing job_id.", true);
    const { data, error } = await supabaseAdmin
      .from("jobs")
      .select(
        "id, hf_model_url, target_format, status, output_hf_repo, error_message, credits_cost, tier, size_b, refund_status, created_at, completed_at",
      )
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return textContent("Job not found (or not owned by this API key).", true);
    return textContent(JSON.stringify(data, null, 2));
  }

  return textContent(`Unknown tool: ${name}`, true);
}

export { handleMcpRequest, jsonRpcError, sseResponse, TOOLS, SERVER_INFO, PROTOCOL_VERSION };
