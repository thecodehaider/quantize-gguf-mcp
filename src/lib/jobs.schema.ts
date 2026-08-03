/**
 * Zod schemas shared by the job and credit server functions.
 *
 * Kept in its own module so both the thin `*.functions.ts` wrappers and their
 * server-only helpers can validate against one definition. Only GGUF is
 * actually implemented today - see `IMPLEMENTED_FORMATS` in `jobs.server.ts`;
 * the other formats are accepted by the type but rejected at submission.
 */
import { z } from "zod";

export const JOB_FORMATS = ["gguf", "awq", "gptq", "exl2"] as const;
export type JobFormat = (typeof JOB_FORMATS)[number];

export const createJobSchema = z.object({
  hf_model_url: z
    .string()
    .url("Must be a URL")
    .refine(
      (u) => {
        try {
          const host = new URL(u).hostname;
          return host === "huggingface.co" || host.endsWith(".huggingface.co");
        } catch {
          return false;
        }
      },
      { message: "URL must be on huggingface.co" },
    ),
  target_format: z.enum(JOB_FORMATS),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const buyPackSchema = z.object({ pack_id: z.string() });
export const buyCustomSchema = z.object({ amount_dollars: z.number().min(5).max(1000) });

/**
 * HF token save payload. Lives here (not in hf-token.functions.ts) because a
 * module declaring createServerFn must not hold runtime values: the server-fn
 * splitter drops module-scope siblings and the handler would ReferenceError.
 */
export const saveHfTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "That doesn't look like an HF token")
    .max(200)
    .regex(/^hf_[A-Za-z0-9]+$/, "Expected a token that starts with 'hf_'"),
});
