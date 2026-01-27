import { z } from "zod";

const confidenceEnum = z.enum(["high", "medium", "low"]);
const urgencyEnum = z.enum(["low", "medium", "high"]);

export const DoculeaResponseSchema = z.object({
  document_type: z.object({
    category: z.enum([
      "utility",
      "bank",
      "credit_card",
      "medical",
      "insurance",
      "debt_collection",
      "government",
      "employment",
      "school",
      "informational",
      "scam",
      "legal",
      "unknown",
    ]),
    confidence: confidenceEnum,
  }),

  legitimacy_assessment: z.object({
    status: z.enum(["likely_legit", "suspicious", "unclear"]),
    confidence: confidenceEnum,
    summary_reason: z.string().min(3),
  }),

  plain_language_summary: z.string().min(10),

  what_this_means_for_you: z.string().min(10),

  step_by_step_actions: z
    .array(
      z.object({
        step: z.number().int().min(1),
        title: z.string().min(3),
        description: z.string().min(8),
        urgency: urgencyEnum,
      })
    )
    .min(2)
    .max(6),

  recommended_actions: z.array(z.string().min(3)).min(1).max(10),

  red_flags: z.array(z.string().min(3)).max(15),

  suggested_scripts: z.object({
    call_script: z.string().min(5).nullable(),
    email_template: z.string().min(5).nullable(),
  }),

  safety_notes: z.string().min(5).nullable(),
});

export type DoculeaResponse = z.infer<typeof DoculeaResponseSchema>;
