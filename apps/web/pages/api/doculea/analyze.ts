import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

import { DOCULEA_SYSTEM_PROMPT, buildDoculeaUserPrompt } from "../../../../../packages/core/src/prompts/doculeaPrompts";
import { DoculeaResponseSchema, DoculeaResponse } from "../../../../../packages/core/src/schema/doculeaSchema";
import { applyHardSafetyOverride } from "../../../../../packages/core/src/safety/doculeaSafety";
import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

//const DEBUG = process.env.NODE_ENV !== "production";

// Hard limits
const MAX_CHARS = 20000; // protect cost/perf

// Long-doc handling (local, no extra model call)
const CONDENSE_THRESHOLD_CHARS = 4500;
const CONDENSE_TARGET_CHARS = 3500;

// OpenAI controls
const OPENAI_TIMEOUT_MS = 30_000;
const OPENAI_MAX_TOKENS = 800;

// ---------- utils ----------

// Generic timeout wrapper that preserves the promise type (works with OpenAI's APIPromise too)
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenAI request timed out")), ms);
    Promise.resolve(promise)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function clipToMaxChars(s: string, maxChars: number) {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

// Simple local “condense” strategy: keep header + tail + middle windows (no extra model calls)
function condenseTextLocal(input: string, targetChars: number) {
  const t = (input || "").trim();
  if (t.length <= targetChars) return t;

  // Keep first 1200, last 1200, and a middle slice around the 50% mark
  const head = t.slice(0, 1200);
  const tail = t.slice(Math.max(0, t.length - 1200));
  const midStart = Math.max(0, Math.floor(t.length * 0.5) - 550);
  const mid = t.slice(midStart, midStart + 1100);

  const joined = [head, "\n\n---\n\n", mid, "\n\n---\n\n", tail].join("");
  return joined.slice(0, targetChars);
}

// Ensure steps are 1..N and limited (schema already enforces, but keep deterministic)
function renumberSteps(result: DoculeaResponse): DoculeaResponse {
  type StepAction = DoculeaResponse["step_by_step_actions"][number];

  result.step_by_step_actions = (result.step_by_step_actions || [])
    .slice(0, 6)
    .map((s: StepAction, idx: number): StepAction => ({ ...s, step: idx + 1 }));

  return result;
}

// ---------- handler ----------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { documentText, lang } = req.body as { documentText?: string; lang?: "en" | "es" };

    if (!documentText || typeof documentText !== "string") {
      return res.status(400).json({ error: "documentText is required." });
    }

    const trimmedText = documentText.trim();

    if (trimmedText.length < 40) {
      return res.status(400).json({ error: "Text is too short. Please provide more of the document." });
    }

    const language: "en" | "es" = lang === "es" ? "es" : "en";

    // Long-doc handling: condense locally; do NOT change AI logic.
    let textForAI = trimmedText;
    if (textForAI.length > CONDENSE_THRESHOLD_CHARS) {
      textForAI = condenseTextLocal(textForAI, CONDENSE_TARGET_CHARS);
    }

    // Hard truncate as last resort
    textForAI = clipToMaxChars(textForAI, MAX_CHARS);

    const userPrompt = buildDoculeaUserPrompt(textForAI, language);

    const completion = await withTimeout(
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: OPENAI_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DOCULEA_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      OPENAI_TIMEOUT_MS
    );

    const raw = completion.choices?.[0]?.message?.content || "";
    if (!raw) return res.status(500).json({ error: "Empty AI response." });

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON." });
    }

    const parsed = DoculeaResponseSchema.safeParse(json);
    if (!parsed.success) {
      if (DEBUG) {
        return res.status(500).json({
          error: "AI output failed schema validation.",
          issues: parsed.error.issues,
          raw,
        });
      }
      return res.status(500).json({ error: "AI output failed schema validation." });
    }

    let result: DoculeaResponse = parsed.data as DoculeaResponse;

    // Guard minimum steps (schema already enforces, but keep explicit)
    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(500).json({ error: "AI output missing minimum step-by-step actions." });
    }

    // Normalize step numbering
    result = renumberSteps(result);

    // Apply hard safety overrides (use original text for scam signals)
    // (TS-safe fallback in case of typing drift)
    result = applyHardSafetyOverride(result, trimmedText, language) ?? result;

    // Bucket mapping
    const { bucket, category } = mapOutputToBucket(result);

    // Attach bucket/category for downstream usage (if you already do)
    // If your schema does not allow these fields, remove this block.
    // (Leaving as-is if you were already returning it.)
    return res.status(200).json({
      ...result,
      bucket,
      bucket_category: category,
    });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
