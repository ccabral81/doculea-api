import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

import { DOCULEA_SYSTEM_PROMPT, buildDoculeaUserPrompt } from "../../../../../packages/core/src/prompts/doculeaPrompts";
import { DoculeaResponseSchema, DoculeaResponse } from "../../../../../packages/core/src/schema/doculeaSchema";
import { applyHardSafetyOverride } from "../../../../../packages/core/src/safety/doculeaSafety";
import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";

type UiActionType = "action_required" | "informational" | "offer";

function looksLikeOffer(text: string): boolean {
  const t = (text || "").toLowerCase();

  const offerWords = [
    "offer", "promotion", "limited time", "act now", "enroll", "enrollment", "sign up", "signup",
    "call", "visit", "optional", "program", "protection program",
    "oferta", "promoción", "promocion", "inscrib", "inscripción", "inscripcion",
    "llama", "visita", "programa", "protección", "proteccion"
  ];

  const hitCount = offerWords.reduce((acc, w) => (t.includes(w) ? acc + 1 : acc), 0);

  const hasMonthlyPrice =
    /\$\s?\d+(?:\.\d{2})?\s*(?:a\s*month|per\s*month)/i.test(text) ||
    /\$\s?\d+(?:\.\d{2})?\s*(?:al\s*mes|por\s*mes)/i.test(text) ||
    /\b\d+(?:\.\d{2})?\s*(?:\/month|\/mes)\b/i.test(text);

  const hasCTA =
    /\b(call|llama)\b[\s\S]{0,80}\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(text) ||
    /\b(visit|visita)\b[\s\S]{0,80}\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(text) ||
    /\b(enroll|inscrib|sign up|inscripción|inscripcion)\b/i.test(text);

  return hitCount >= 2 || hasMonthlyPrice || hasCTA;
}

function deriveUiActionType(result: any, rawText: string): UiActionType {
  const category = result?.document_type?.category;
  const status = result?.legitimacy_assessment?.status;

  // suspicious -> treat as informational (avoid actions that contact unknown parties)
  if (status === "suspicious") return "informational";

  const combined =
    String(rawText || "") +
    "\n\n" +
    String(result?.plain_language_summary || "") +
    "\n\n" +
    String(result?.what_this_means_for_you || "");

  // ✅ Catch offers even when model labels as informational
  if (looksLikeOffer(combined)) return "offer";

  // usually actionable categories
  if (["utility", "medical", "insurance", "debt_collection", "government", "employment", "school"].includes(category)) {
    return "action_required";
  }

  return "informational";
}

function stripScripts(result: any) {
  return {
    ...result,
    suggested_scripts: { call_script: "", email_template: "" },
  };
}

function sanitizeOfferOutput(result: any, language: "en" | "es") {
  const safeSteps =
    language === "es"
      ? [
          {
            step: 1,
            title: "Identificar que es una oferta",
            description:
              "Este documento parece ser una oferta o promoción. No es obligatorio inscribirse ni comprar nada.",
            urgency: "low",
          },
          {
            step: 2,
            title: "Ignorar si no te interesa",
            description:
              "Si no lo solicitaste o no lo necesitas, puedes ignorarlo. Evita llamar números o visitar enlaces impresos en la carta.",
            urgency: "low",
          },
          {
            step: 3,
            title: "Verificar por canales oficiales (opcional)",
            description:
              "Si realmente te interesa, busca la empresa por tu cuenta y compara alternativas antes de decidir.",
            urgency: "low",
          },
        ]
      : [
          {
            step: 1,
            title: "Recognize this is an offer",
            description:
              "This document appears to be a marketing offer or promotion. You are not required to sign up or purchase anything.",
            urgency: "low",
          },
          {
            step: 2,
            title: "Ignore if you’re not interested",
            description:
              "If you didn’t request it or don’t need it, you can ignore it. Avoid calling numbers or clicking links printed on the letter.",
            urgency: "low",
          },
          {
            step: 3,
            title: "Verify via official sources (optional)",
            description:
              "If you truly want it, look up the company independently and compare alternatives before deciding.",
            urgency: "low",
          },
        ];

  const extraSafety =
    language === "es"
      ? "Nota: Para ofertas, evita llamar números o visitar enlaces impresos en la carta. Si decides investigar, busca la empresa por tu cuenta."
      : "Note: For offers, avoid calling numbers or clicking links printed on the letter. If you investigate, look up the company independently.";

  return {
    ...result,
    step_by_step_actions: safeSteps,
    recommended_actions: [],
    suggested_scripts: { call_script: "", email_template: "" },
    safety_notes: result?.safety_notes ? `${result.safety_notes}\n\n${extraSafety}` : extraSafety,
  };
}


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBUG = process.env.NODE_ENV !== "production";

// Hard limits
const MAX_CHARS = 20000; // protect cost/perf

// Long-doc handling (local, no extra model call)
const CONDENSE_THRESHOLD_CHARS = 4500;
const CONDENSE_TARGET_CHARS = 3500;

// OpenAI controls
const OPENAI_TIMEOUT_MS = 30_000;
const OPENAI_MAX_TOKENS = 800;

// ---------- utils ----------

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
  if (input === "es" || input === "spanish") return "es";
  return "en";
}

function pickDocumentText(body: any): string | undefined {
  // Accept both old + new payload shapes
  return (
    body?.documentText ??
    body?.text ??
    body?.rawText ??
    body?.document_text ??
    body?.document_text_raw
  );
}

// ---------- handler ----------

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
        return res.status(500).json({ error: "AI output failed schema validation.", details: parsed.error.format() });
      }
      return res.status(500).json({ error: "AI output failed schema validation." });
    }

    let result = parsed.data as DoculeaResponse;

    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(500).json({ error: "AI output missing minimum step-by-step actions." });
    }

    result = renumberSteps(result);

    // Apply hard safety overrides (use original text for scam signals)
    result = applyHardSafetyOverride(result, trimmedText, language);
    // Determine UI intent type (offer vs action-required vs informational) based on BOTH model output and raw text
    const ui_action_type = deriveUiActionType(result, trimmedText);
    (result as any).ui_action_type = ui_action_type;

    // Offer guardrail: never encourage sign-up/call/visit
    if (ui_action_type === "offer") {
      result = sanitizeOfferOutput(result, language);
    }

    // Additional safety: hide scripts for suspicious/unclear (and offers already handled)
    const st = result.legitimacy_assessment?.status;
    if (st === "suspicious" || st === "unclear" || ui_action_type === "offer") {
      result = stripScripts(result);
    }

    const { bucket, category } = mapOutputToBucket(result);

    return res.status(200).json({ ...result, ui_action_type: (result as any).ui_action_type, bucket, category });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}



