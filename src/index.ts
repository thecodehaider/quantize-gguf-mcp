/**
 * QuantizeLab MCP server — standalone Cloudflare Worker entry point.
 *
 * Streamable HTTP transport (JSON-RPC 2.0). `POST` handles the MCP protocol,
 * `GET` returns server metadata for discovery.
 *
 * Env (secrets via `wrangler secret put`): see wrangler.toml.
 */
import { createClient } from "@supabase/supabase-js";
import { handleMcpRequest, sseResponse, jsonRpcError, TOOLS } from "./mcp";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HF_TOKEN_ENC_KEY?: string;
  IP_HASH_PEPPER?: string;
  MODAL_ENDPOINT_URL?: string;
  SITE_URL?: string;
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Workers populate process.env from bindings under nodejs_compat, but make
    // it explicit so the same handler also runs in plain Node during tests.
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") (process.env as Record<string, string>)[k] = v;
    }

    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    if (request.method === "GET") {
      return Response.json({
        name: "QuantizeLab MCP server",
        protocol: "Streamable HTTP (JSON-RPC 2.0)",
        endpoint: "POST /",
        auth: "Authorization: Bearer ql_... (generate an API key in the dashboard)",
        tools: TOOLS.map((t) => t.name),
        docs: "https://quantizelab.dev/developers",
      });
    }

    if (request.method === "POST") {
      const acceptsSse = (request.headers.get("accept") ?? "").includes("text/event-stream");
      const authHeader = request.headers.get("authorization");
      try {
        const body = await request.json();
        return await handleMcpRequest(body, authHeader, acceptsSse, supabaseAdmin, request);
      } catch (e) {
        const err = jsonRpcError(null, -32700, "Parse error: request body must be JSON-RPC 2.0.");
        return acceptsSse ? sseResponse(err) : Response.json(err);
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
