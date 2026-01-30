import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

import { DOCULEA_SYSTEM_PROMPT, buildDoculeaUserPrompt } from "../../../../../packages/core/src/prompts/doculeaPrompts";
import { DoculeaResponseSchema, DoculeaResponse } from "../../../../../packages/core/src/schema/doculeaSchema";
import { applyHardSafetyOverride } from "../../../../../packages/core/src/safety/doculeaSafety";
import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBUG = process.env.NODE_ENV !== "production";

// Hard limits
const MAX_CHARS = 20000;

// Long-doc handling (local)
const CONDENSE_THRESHOLD_CHARS = 4500;
const CONDENSE_TARGET_CHARS = 3500;

// OpenAI controls
const OPENAI_TIMEOUT_MS = 30_000;
const OPENAI_MAX_TOKENS = 1200; // ↑ helps avoid truncated/invalid shape

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

function condenseTextLocal(input: string, targetChars: number) {
  const t = (input || "").trim();
  if (t.length <= targetChars) return t;

  const head = t.slice(0, 1200);
  const tail = t.slice(Math.max(0, t.length - 1200));
  const midStart = Math.max(0, Math.floor(t.length * 0.5) - 550);
  const mid = t.slice(midStart, midStart + 1100);

  const joined = [head, "\n\n---\n\n", mid, "\n\n---\n\n", tail].join("");
  return joined.slice(0, targetChars);
}

function renumberSteps(result: DoculeaResponse): DoculeaResponse {
  type StepAction = DoculeaResponse["step_by_step_actions"][number];

  result.step_by_step_actions = (result.step_by_step_actions || [])
    .slice(0, 6)
    .map((s: StepAction, idx: number): StepAction => ({ ...s, step: idx + 1 }));

  return result;
}

function normalizeLang(input: unknown): "en" | "es" {
  const v = String(input || "").toLowerCase().trim();
  if (v === "es" || v.startsWith("es-") || v === "spanish" || v === "espanol" || v === "español") return "es";
  if (v === "en" || v.startsWith("en-") || v === "english") return "en";
  return "en";
}

function pickDocumentText(body: any): string | undefined {
  return (
    body?.documentText ??
    body?.text ??
    body?.rawText ??
    body?.document_text ??
    body?.document_text_raw
  );
}

// Deterministic coercion: maps common field variants into expected schema keys (no extra model calls)
function coerceToDoculeaShape(input: any, language: "en" | "es") {
  const o: any = input && typeof input === "object" ? { ...input } : {};

  // Summary
  if (!o.plain_language_summary && o.plain_summary) o.plain_language_summary = o.plain_summary;
  if (!o.plain_language_summary && o.summary) o.plain_language_summary = o.summary;

  // Meaning
  if (!o.what_this_means_for_you && o.what_it_means) o.what_this_means_for_you = o.what_it_means;
  if (!o.what_this_means_for_you && o.meaning) o.what_this_means_for_you = o.meaning;

  // Legitimacy
  if (!o.legitimacy_assessment && o.legitimacy) {
    const statusRaw = String(o.legitimacy || "").toLowerCase();
    const status =
      statusRaw.includes("susp") ? "suspicious" :
      statusRaw.includes("unclear") ? "unclear" :
      statusRaw.includes("legit") ? "likely_legit" :
      "unclear";

    o.legitimacy_assessment = {
      status,
      confidence: o.legitimacy_confidence ?? 0.6,
      summary_reason: o.legitimacy_reason ?? o.reason ?? "",
    };
  }

  // Document type
  if (typeof o.document_type === "string") {
    o.document_type = { category: o.document_type, confidence: 0.6 };
  }
  if (!o.document_type && o.category) {
    o.document_type = { category: o.category, confidence: 0.6 };
  }

  // Steps mapping
  if (!o.step_by_step_actions && o.next_steps) {
    if (Array.isArray(o.next_steps)) {
      o.step_by_step_actions = o.next_steps.map((s: any, idx: number) => {
        if (typeof s === "string") {
          return {
            step: idx + 1,
            title: language === "es" ? `Paso ${idx + 1}` : `Step ${idx + 1}`,
            description: s,
            urgency: "medium",
          };
        }
        return {
          step: s.step ?? (idx + 1),
          title: s.title ?? s.action ?? (language === "es" ? `Paso ${idx + 1}` : `Step ${idx + 1}`),
          description: s.description ?? s.details ?? s.text ?? "",
          urgency: s.urgency ?? "medium",
        };
      });
    }
  }

  // Scripts mapping
  if (!o.suggested_scripts && o.scripts) {
    o.suggested_scripts = {
      call_script: o.scripts.call_script ?? o.scripts.call ?? "",
      email_template: o.scripts.email_template ?? o.scripts.email ?? "",
    };
  }

  // Safety notes
  if (Array.isArray(o.safety_notes)) o.safety_notes = o.safety_notes.join("\n");

  // Red flags
  if (typeof o.red_flags === "string") {
    o.red_flags = o.red_flags.split("\n").map((x: string) => x.trim()).filter(Boolean);
  }

  return o;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = (req.body ?? {}) as any;

    const documentText = pickDocumentText(body);
    const lang = body?.lang ?? body?.language;

    if (!documentText || typeof documentText !== "string") {
      return res.status(400).json({
        error: "documentText is required.",
        hint: "Send { documentText, lang } (old) or { text, language } (new).",
      });
    }

    const trimmedText = documentText.trim();
    if (trimmedText.length < 40) {
      return res.status(400).json({ error: "Text is too short. Please provide more of the document." });
    }

    const language: "en" | "es" = normalizeLang(lang);

    let textForAI = trimmedText;
    if (textForAI.length > CONDENSE_THRESHOLD_CHARS) {
      textForAI = condenseTextLocal(textForAI, CONDENSE_TARGET_CHARS);
    }
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
      return res.status(502).json({ error: "AI returned invalid JSON." });
    }

    // ✅ deterministic coercion first
    const coerced = coerceToDoculeaShape(json as any, language);

    const parsed = DoculeaResponseSchema.safeParse(coerced);
    if (!parsed.success) {
      // ✅ 422 instead of 500 for validation failures
      if (DEBUG) {
        return res.status(422).json({
          error: "AI output failed schema validation.",
          details: parsed.error.format(),
        });
      }
      return res.status(422).json({ error: "AI output failed schema validation." });
    }

    let result = parsed.data as DoculeaResponse;

    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(422).json({ error: "AI output missing minimum step-by-step actions." });
    }

    result = renumberSteps(result);

    // Safety override after model output
    result = applyHardSafetyOverride(result, trimmedText, language);

    const { bucket, category } = mapOutputToBucket(result);

    return res.status(200).json({ ...result, bucket, category });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    // IMPORTANT: surface real error message
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}

