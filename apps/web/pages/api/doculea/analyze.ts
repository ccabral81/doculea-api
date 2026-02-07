
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

import { DOCULEA_SYSTEM_PROMPT, buildDoculeaUserPrompt } from "../../../../../packages/core/src/prompts/doculeaPrompts";
import { DoculeaResponseSchema, DoculeaResponse } from "../../../../../packages/core/src/schema/doculeaSchema";
import { applyHardSafetyOverride, applyGovernmentSolicitationOverride, applyEcommerceNormalizationOverride, applyIntentAndPressureOverride, detectFormIntent, isGovernmentNotice } from "../../../../../packages/core/src/safety/doculeaSafety";
import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";


function looksLikeForm(text: string) {
  // Gate Form Mode by *intent* and exclude government notices that may have structured layouts.
  if (!detectFormIntent(text)) return false;
  if (isGovernmentNotice(text)) return false;

  const t = text.toLowerCase();
  return (
    /yes\s*\/\s*no/.test(t) ||
    /\bparent\b|\bguardian\b|\bstudent\b/.test(t) ||
    /\bsignature\b/.test(t) ||
    /\bdate\b/.test(t) ||
    /\bgrade\b|\bschool\b|\bdistrict\b/.test(t) ||
    /\bmedical\b|\bdoctor\b|\bphysician\b|\bimmuniz\b/.test(t)
  );
}

function applyFormGuidanceOverride(result: any, rawText: string, lang: "en" | "es") {
  if (!looksLikeForm(rawText)) return result;

    if (isGovernmentNotice(rawText)) return result;

const isSchool =
    /school|district|student|parent|guardian|grade/.test(rawText.toLowerCase());
  const isMedical =
    /medical|doctor|physician|clinic|immuniz|patient/.test(rawText.toLowerCase());

  // Keep schema stable: we only adjust existing fields
  const category = isSchool ? "school" : isMedical ? "medical" : "informational";

  result.document_type = {
    ...(result.document_type || {}),
    category,
    confidence: result.document_type?.confidence || "medium",
  };

  // Replace "what this means" with a form-friendly explanation
  result.what_this_means_for_you =
    lang === "es"
      ? "Este documento parece ser un formulario para completar. No es una factura ni un pago. Normalmente requiere que marques opciones (Sí/No), completes datos básicos y firmes como padre/madre o tutor."
      : "This looks like a form to complete. It’s not a bill or payment. You’ll usually need to check options (Yes/No), fill basic information, and sign as a parent/guardian.";

  // Replace step-by-step actions to focus on completion + safety
  result.step_by_step_actions = [
    {
      step: 1,
      title: lang === "es" ? "Identifica qué te piden" : "Identify what’s requested",
      description:
        lang === "es"
          ? "Busca campos como nombre del estudiante, fecha, firma, y preguntas Sí/No."
          : "Look for fields like student name, date, signature, and Yes/No questions.",
      urgency: "low",
    },
    {
      step: 2,
      title: lang === "es" ? "Completa sin adivinar" : "Fill it out without guessing",
      description:
        lang === "es"
          ? "Si una pregunta no está clara, no inventes. Pregunta a la escuela/consulta al médico o traduce esa sección específica."
          : "If a question isn’t clear, don’t guess. Ask the school/doctor or translate that specific section.",
      urgency: "medium",
    },
    {
      step: 3,
      title: lang === "es" ? "Firma y entrega" : "Sign and submit",
      description:
        lang === "es"
          ? "Firma donde corresponda y entrégalo según las instrucciones del documento (escuela/portal)."
          : "Sign where needed and submit it using the instructions in the document (school/portal).",
      urgency: "medium",
    },
  ];

  // Keep red flags focused (do NOT add payment/call scripts for forms)
  result.red_flags = Array.isArray(result.red_flags) ? result.red_flags : [];
  result.suggested_scripts = result.suggested_scripts || {};
  result.suggested_scripts.call_script = null;
  result.suggested_scripts.email_template = null;

  return result;
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
    // Government-like solicitations (e.g., NJ annual report private filing services)
    result = applyGovernmentSolicitationOverride(result, trimmedText, language);
    // E-commerce order confirmations (e.g., Temu) should be informational by default
    result = applyEcommerceNormalizationOverride(result, trimmedText, language);
    result = applyFormGuidanceOverride(result, trimmedText, language);

    // Offers vs obligations vs manipulative solicitations (pressure language guardrails)
    result = applyIntentAndPressureOverride(result, trimmedText, language);

const { bucket, category } = mapOutputToBucket(result);

    return res.status(200).json({ ...result, bucket, category });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
