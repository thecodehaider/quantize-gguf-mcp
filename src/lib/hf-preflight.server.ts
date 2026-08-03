/**
 * Server-only preflight for a submitted Hugging Face model URL.
 *
 * Why: pricing only reads the *repo name* (`-8B`), so anything that looks like
 * a URL used to sail straight through to Modal - a dataset, a Space, a private
 * or gated repo, a diffusion model, or a repo that only ships `.gguf` files.
 * Those all burn a GPU container for several minutes and then fail, which
 * means a charge, a refund, and a confused user.
 *
 * This module asks the HF Hub API the cheap questions first, using the user's
 * own token, and blocks with a specific message before any credits move.
 * It is deliberately conservative: unknown/ambiguous signals are allowed
 * through (Modal is still the source of truth), only clear negatives block.
 */
import { fetchWithTimeout } from "./errors.server";
import { MAX_MODEL_B } from "./pricing";

/** Paths on huggingface.co that are not model repos. */
const NON_MODEL_PREFIXES = new Set([
  "datasets",
  "spaces",
  "collections",
  "docs",
  "blog",
  "papers",
  "posts",
  "organizations",
  "settings",
  "pricing",
  "join",
  "login",
]);

/**
 * Turn any huggingface.co model URL into a bare `owner/repo` id.
 * Tolerates `/tree/main`, `/blob/main/config.json`, query strings and
 * trailing slashes. Returns a reason string when the URL isn't a model repo.
 */
export function parseHfRepoId(
  hfUrl: string,
): { ok: true; repoId: string } | { ok: false; reason: string } {
  let path: string;
  try {
    path = new URL(hfUrl).pathname;
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return {
      ok: false,
      reason: "Paste a link to a specific model repo, e.g. huggingface.co/owner/model.",
    };
  }
  const head = segments[0].toLowerCase();
  if (NON_MODEL_PREFIXES.has(head)) {
    const kind = head === "datasets" ? "dataset" : head === "spaces" ? "Space" : head;
    return {
      ok: false,
      reason: `That's a ${kind} page, not a model repo. Paste a link like huggingface.co/owner/model.`,
    };
  }
  if (segments.length < 2) {
    return {
      ok: false,
      reason: "That looks like a user or org page. Paste a link to a specific model repo.",
    };
  }
  // Drop /tree/... /blob/... /resolve/... /commit/... tails.
  const repoId = `${segments[0]}/${segments[1]}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoId)) {
    return { ok: false, reason: "Couldn't read an owner/model name from that URL." };
  }
  return { ok: true, repoId };
}

/** Weight files `convert_hf_to_gguf.py` can actually read. */
function isConvertibleWeight(name: string): boolean {
  const f = name.toLowerCase();
  return (
    f.endsWith(".safetensors") ||
    /(^|\/)(pytorch_model|model)[\w.-]*\.bin$/.test(f) ||
    f.endsWith(".pth") ||
    f.endsWith(".ckpt")
  );
}

/**
 * Architectures llama.cpp's HF->GGUF converter supports. Matched
 * case-insensitively; the list is a allow-check only - if `config.json`
 * exposes no architectures we don't block on this rule.
 */
const SUPPORTED_ARCH_HINTS = [
  "llama",
  "mistral",
  "mixtral",
  "qwen",
  "gemma",
  "phi",
  "stablelm",
  "falcon",
  "gptneox",
  "gptbigcode",
  "gpt2",
  "gptj",
  "mpt",
  "starcoder",
  "bloom",
  "cohere",
  "command",
  "minicpm",
  "internlm",
  "deepseek",
  "olmo",
  "granite",
  "nemotron",
  "exaone",
  "chatglm",
  "glm",
  "baichuan",
  "yi",
  "orion",
  "xverse",
  "plamo",
  "codeshell",
  "persimmon",
  "rwkv",
  "mamba",
  "jais",
  "dbrx",
  "arctic",
  "smollm",
  "bert",
  "roberta",
  "nomic",
  "jina",
  "t5",
  "gptoss",
  "gpt_oss",
  "seed",
  "hunyuan",
  "ernie",
  "apertus",
  "lfm2",
  "bailing",
  "dots",
];

export function isSupportedArchitecture(architectures: string[] | undefined | null): boolean {
  if (!architectures || architectures.length === 0) return true; // unknown -> allow
  return architectures.some((a) => {
    const lower = String(a).toLowerCase();
    return SUPPORTED_ARCH_HINTS.some((hint) => lower.includes(hint));
  });
}

/**
 * Pipeline tags that are definitely not text LLMs. `convert_hf_to_gguf.py`
 * has no path for these, so they always burn a container and fail.
 */
const BLOCKED_PIPELINE_TAGS: Record<string, string> = {
  "text-to-image": "an image generation model",
  "image-to-image": "an image-to-image model",
  "text-to-video": "a video generation model",
  "image-to-video": "a video generation model",
  "text-to-speech": "a speech synthesis model",
  "text-to-audio": "an audio generation model",
  "automatic-speech-recognition": "a speech recognition model",
  "audio-classification": "an audio classification model",
  "image-classification": "an image classification model",
  "object-detection": "an object detection model",
  "image-segmentation": "a segmentation model",
  "depth-estimation": "a depth estimation model",
  "unconditional-image-generation": "an image generation model",
};

/**
 * Repo tags that mean the weights on disk are *already* quantized by another
 * toolchain. llama.cpp's converter reads full-precision (fp16/bf16/fp32)
 * tensors only and errors out on these packed formats.
 */
const PREQUANTIZED_TAG_HINTS = [
  "bitsandbytes",
  "gptq",
  "awq",
  "compressed-tensors",
  "aqlm",
  "quanto",
  "hqq",
  "eetq",
  "fbgemm",
  "marlin",
  "exl2",
  "exllama",
  "mlx",
  "4-bit",
  "8-bit",
];

/** Human label for a `quantization_config.quant_method` value. */
function quantMethodLabel(method: string): string {
  const m = method.toLowerCase();
  if (m.includes("bitsandbytes")) return "bitsandbytes (4-bit/8-bit)";
  if (m.includes("gptq")) return "GPTQ";
  if (m.includes("awq")) return "AWQ";
  if (m.includes("compressed")) return "compressed-tensors";
  if (m.includes("fp8")) return "FP8";
  return method;
}

/**
 * `quant_method` values that llama.cpp CAN read. Currently only fp8 checkpoints
 * are handled by recent converter builds; everything else is a hard block.
 */
function isConvertibleQuantMethod(method: string | undefined | null): boolean {
  if (!method) return true;
  return String(method).toLowerCase().includes("fp8");
}

type HfModelInfo = {
  id?: string;
  gated?: boolean | string;
  private?: boolean;
  library_name?: string;
  pipeline_tag?: string;
  tags?: string[];
  siblings?: Array<{ rfilename?: string }>;
  config?: {
    architectures?: string[];
    model_type?: string;
    quantization_config?: { quant_method?: string };
  };
  safetensors?: { total?: number };
};

export type PreflightResult =
  | { ok: true; repoId: string; paramsB: number | null }
  | { ok: false; message: string };

/**
 * Verify the repo exists, is reachable with this user's token, and holds
 * weights llama.cpp can convert to GGUF. Network/parse problems are treated as
 * "allow" so a Hub hiccup never blocks a legitimate paying submission.
 */
export async function preflightGgufSource(
  hfUrl: string,
  hfToken: string,
): Promise<PreflightResult> {
  const parsed = parseHfRepoId(hfUrl);
  if (!parsed.ok) return { ok: false, message: parsed.reason };
  const { repoId } = parsed;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://huggingface.co/api/models/${encodeURI(repoId)}`,
      { headers: { Authorization: `Bearer ${hfToken}`, Accept: "application/json" } },
      10_000,
    );
  } catch (e) {
    console.error("[hf_preflight_network]", { repoId, error: e });
    return { ok: true, repoId, paramsB: null }; // fail open
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        "Your Hugging Face token can't access that repo. It may be gated or private - accept the licence on the model page (or reconnect a token with read access) and try again.",
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      message: `We couldn't find the model repo "${repoId}" on Hugging Face. Check the URL for typos.`,
    };
  }
  if (!res.ok) {
    console.error("[hf_preflight_status]", { repoId, status: res.status });
    return { ok: true, repoId, paramsB: null }; // fail open
  }

  let info: HfModelInfo;
  try {
    info = (await res.json()) as HfModelInfo;
  } catch {
    return { ok: true, repoId, paramsB: null };
  }

  const files = (info.siblings ?? []).map((s) => s.rfilename ?? "").filter(Boolean);
  const hasConvertible = files.some(isConvertibleWeight);
  const hasGguf = files.some((f) => f.toLowerCase().endsWith(".gguf"));
  const lowerFiles = files.map((f) => f.toLowerCase());
  const isAdapterRepo =
    lowerFiles.some((f) => f.endsWith("adapter_config.json")) ||
    lowerFiles.some((f) => f.endsWith("adapter_model.safetensors"));

  // LoRA/PEFT adapters need convert_lora_to_gguf.py plus a base model; the
  // straight HF->GGUF path cannot read them on their own.
  if (isAdapterRepo) {
    return {
      ok: false,
      message:
        "That's a LoRA/adapter repo, not a full model. Adapters can't be quantized on their own - paste the merged or base model repo instead.",
    };
  }

  if (!hasConvertible) {
    if (hasGguf) {
      return {
        ok: false,
        message:
          "That repo already ships GGUF files - there's nothing to quantize. Point us at the original full-precision model repo.",
      };
    }
    if (files.length > 0) {
      return {
        ok: false,
        message:
          "That repo has no model weights we can convert (no .safetensors or .bin files). Paste the full-precision model repo.",
      };
    }
  }

  // The converter reads config.json to pick an architecture handler. No
  // config.json means it cannot start at all.
  if (files.length > 0 && !lowerFiles.some((f) => f === "config.json")) {
    return {
      ok: false,
      message:
        "That repo has no config.json, so we can't tell llama.cpp what architecture it is. Paste a standard Transformers model repo.",
    };
  }

  const library = (info.library_name ?? "").toLowerCase();
  if (library === "diffusers") {
    return {
      ok: false,
      message:
        "That's an image/diffusion model. GGUF quantization here only supports text LLM repos.",
    };
  }
  if (library === "peft") {
    return {
      ok: false,
      message:
        "That's a PEFT/LoRA adapter repo. Paste the merged or base model repo instead - adapters can't be quantized on their own.",
    };
  }

  // Modality check: a speech or vision repo will never produce a text GGUF.
  const pipeline = (info.pipeline_tag ?? "").toLowerCase();
  const blockedPipeline = BLOCKED_PIPELINE_TAGS[pipeline];
  if (blockedPipeline) {
    return {
      ok: false,
      message: `That's ${blockedPipeline}, not a text LLM. GGUF quantization here only supports text generation repos.`,
    };
  }

  // Already-quantized weights: block on the declared quant method first
  // (authoritative), then fall back to repo tags.
  const quantMethod = info.config?.quantization_config?.quant_method;
  if (quantMethod && !isConvertibleQuantMethod(quantMethod)) {
    return {
      ok: false,
      message: `Those weights are already quantized with ${quantMethodLabel(String(quantMethod))}, which llama.cpp can't convert. Paste the original fp16/bf16 model repo.`,
    };
  }
  if (!quantMethod) {
    const tags = (info.tags ?? []).map((t) => String(t).toLowerCase());
    const hint = PREQUANTIZED_TAG_HINTS.find((h) => tags.includes(h));
    if (hint) {
      return {
        ok: false,
        message: `That repo looks pre-quantized (${hint}), and llama.cpp can only convert full-precision weights. Paste the original fp16/bf16 model repo.`,
      };
    }
  }

  if (!isSupportedArchitecture(info.config?.architectures)) {
    const arch = info.config?.architectures?.[0] ?? "unknown";
    return {
      ok: false,
      message: `llama.cpp can't convert this model architecture yet (${arch}). Try a Llama, Mistral, Qwen, Gemma or Phi family repo.`,
    };
  }

  // Real parameter count when the Hub exposes it - far more reliable than the
  // repo-name guess, so use it to enforce the size ceiling.
  const total = info.safetensors?.total;
  const paramsB = typeof total === "number" && total > 0 ? total / 1e9 : null;
  if (paramsB !== null && paramsB > MAX_MODEL_B * 1.05) {
    return {
      ok: false,
      message: `That model is about ${paramsB.toFixed(1)}B parameters. We support up to ${MAX_MODEL_B}B for now.`,
    };
  }

  return { ok: true, repoId, paramsB };
}
