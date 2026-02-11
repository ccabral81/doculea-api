// apps/web/pages/api/doculea/analyze.ts (or your current path)
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

import {
  DOCULEA_SYSTEM_PROMPT,
  buildDoculeaUserPrompt,
} from "../../../../../packages/core/src/prompts/doculeaPrompts";

import {
  DoculeaResponseSchema,
  DoculeaResponse,
} from "../../../../../packages/core/src/schema/doculeaSchema";

import {
  applyHardSafetyOverride,
  applyGovernmentSolicitationOverride,
  applyEcommerceNormalizationOverride,
  applyIntentAndPressureOverride,
  applyUserDemandOverride,
  detectFormIntent,
} from "../../../../../packages/core/src/safety/doculeaSafety";

import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEBUG = process.env.NODE_ENV !== "production";

// Hard limits
const MAX_CHARS = 20000;

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

function toConfidenceEnum(v: any): "high" | "medium" | "low" {
  if (v === "high" || v === "medium" || v === "low") return v;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "medium";
  if (n >= 0.8) return "high";
  if (n >= 0.5) return "medium";
  return "low";
}

// -----------------------
// Offer detection (deterministic, raw-text driven)
// -----------------------
function looksLikeOffer(text: string) {
  const t = (text || "").toLowerCase();

  const offerWords = [
    "offer",
    "promotion",
    "limited time",
    "act now",
    "enroll",
    "enrollment",
    "sign up",
    "signup",
    "optional",
    "program",
    "protection program",
    "oferta",
    "promoción",
    "promocion",
    "inscrib",
    "inscripción",
    "inscripcion",
    "opcional",
    "programa",
    "protección",
    "proteccion",
  ];

  const hits = offerWords.filter((w) => t.includes(w)).length;

  const hasMonthlyPrice =
    /\$\s?\d+(?:\.\d{2})?\s*(?:a\s*month|per\s*month)/i.test(text) ||
    /\$\s?\d+(?:\.\d{2})?\s*(?:al\s*mes|por\s*mes)/i.test(text) ||
    /\b\d+(?:\.\d{2})?\s*(?:\/month|\/mes)\b/i.test(text);

  const hasCTA =
    /\b(call|llama)\b.*\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(text) ||
    /\b(visit|visita)\b.*\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(text) ||
    /\b(enroll|inscrib|sign up|inscripción|inscripcion)\b/i.test(text);

  return hits >= 2 || hasMonthlyPrice || hasCTA;
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
              "Si no lo solicitaste o no lo necesitas, puedes ignorarlo. Evita llamar números o visitar enlaces impresos en el documento.",
            urgency: "low",
          },
          {
            step: 3,
            title: "Verificar por canales oficiales (opcional)",
            description:
              "Si te interesa, busca la empresa por tu cuenta (sitio oficial desde un buscador, reseñas confiables) y compara alternativas antes de decidir.",
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
              "If you want it, look up the company independently (official website via search, reputable reviews) and compare alternatives before deciding.",
            urgency: "low",
          },
        ];

  result.step_by_step_actions = safeSteps;

  // Remove scripts to avoid driving signups/purchases
  result.suggested_scripts = { call_script: null, email_template: null };
  result.recommended_actions = [];

  const extraSafety =
    language === "es"
      ? "Nota: Para ofertas, evita llamar números o visitar enlaces impresos en la carta. Si investigas, busca la empresa por tu cuenta."
      : "Note: For offers, avoid calling numbers or clicking links printed on the letter. If you investigate, look up the company independently.";

  result.safety_notes = result.safety_notes
    ? `${result.safety_notes}\n\n${extraSafety}`
    : extraSafety;

  if (!Array.isArray(result.red_flags)) result.red_flags = [];
  const offerFlag =
    language === "es"
      ? "Es una oferta/promoción: no es obligatorio inscribirse."
      : "This is an offer/promotion: you are not required to sign up.";
  if (!result.red_flags.includes(offerFlag)) result.red_flags.unshift(offerFlag);

  return result;
}

// -----------------------
// Form guidance override (safe + gated)
// Uses detectFormIntent() from doculeaSafety to avoid gov notices getting form steps.
// -----------------------
function applyFormGuidanceOverride(result: any, rawText: string, lang: "en" | "es") {
  if (!detectFormIntent(rawText)) return result;

  const lower = rawText.toLowerCase();

  const isSchool =
    /school|district|student|parent|guardian|grade|escuela|distrito|estudiante|padre|tutor|grado/.test(
      lower
    );
  const isMedical =
    /medical|doctor|physician|clinic|immuniz|patient|m[eé]dic|doctor|cl[ií]nic|inmuniz|paciente/.test(
      lower
    );

  const category = isSchool ? "school" : isMedical ? "medical" : "informational";

  result.document_type = {
    ...(result.document_type || {}),
    category,
    confidence: result.document_type?.confidence || "medium",
  };

  result.what_this_means_for_you =
    lang === "es"
      ? "Este documento parece ser un formulario para completar. No es una factura ni un pago. Normalmente requiere que marques opciones (Sí/No), completes datos básicos y firmes como padre/madre o tutor."
      : "This looks like a form to complete. It’s not a bill or payment. You’ll usually need to check options (Yes/No), fill basic information, and sign as a parent/guardian.";

  result.step_by_step_actions = [
    {
      step: 1,
      title: lang === "es" ? "Identifica qué te piden" : "Identify what’s requested",
      description:
        lang === "es"
          ? "Busca campos como nombre, fecha, firma, y preguntas Sí/No."
          : "Look for fields like name, date, signature, and Yes/No questions.",
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

  // Avoid scripts for forms
  result.red_flags = Array.isArray(result.red_flags) ? result.red_flags : [];
  result.suggested_scripts = { call_script: null, email_template: null };

  return result;
}

// -----------------------
// UI action type (for your front-end gating)
// Priority: suspicious => informational; actionable category (med/high) => action_required;
// else deterministic offer detection on rawText + narrative.
// -----------------------

function looksLikeBillOrStatement(text: string) {
  const t = (text || "").toLowerCase();

  const billSignals = [
    "amount due",
    "total due",
    "balance due",
    "due date",
    "billing period",
    "statement date",
    "account number",
    "acct #",
    "service address",
    "meter",
    "previous balance",
    "current charges",
    "payment received",
    "make payment",
    "payment stub",
    "remit",
    "remittance",
    "autopay",
    "auto pay",
    "disconnect",
    "past due",
    "late fee",
  ];

  const hits = billSignals.filter((w) => t.includes(w)).length;
  return hits >= 2; // keep it conservative
}

function looksLikeViewOnlyAccountNotice(text: string): boolean {
  const t = (text || "").toLowerCase();

  const viewSignals = [
    "annual account summary",
    "account summary is now ready",
    "statement is ready",
    "available in the",
    "citi mobile",
    "citi online",
    "view now",
    "see all purchases",
    "export your summary",
    // Spanish equivalents if needed later
    "resumen",
    "ya está disponible",
    "ver ahora",
  ];

  const paySignals = [
    "amount due",
    "total due",
    "balance due",
    "minimum payment",
    "past due",
    "due date",
    "late fee",
    "make a payment",
    "pay now",
    // Spanish
    "monto a pagar",
    "total a pagar",
    "saldo",
    "pago mínimo",
    "vencimiento",
    "mora",
    "pagar ahora",
  ];

  const dangerSignals = [
    "account locked",
    "suspended",
    "restricted",
    "fraud",
    "unauthorized",
    "verify your identity",
    "your card was declined",
    "security alert",
    // Spanish
    "bloqueada",
    "suspendida",
    "fraude",
    "no autorizada",
    "verifica tu identidad",
    "alerta de seguridad",
  ];

  const hasView = viewSignals.some((s) => t.includes(s));
  const hasPay = paySignals.some((s) => t.includes(s));
  const hasDanger = dangerSignals.some((s) => t.includes(s));

  return hasView && !hasPay && !hasDanger;
}


function deriveUiActionType(
  result: any,
  rawText: string  
): "action_required" | "informational" | "offer" {

  
  const category = result?.document_type?.category;
  const catConf = result?.document_type?.confidence; // "high" | "medium" | "low"
  const status = result?.legitimacy_assessment?.status;

  // If suspicious, avoid action-required flows; treat as informational/safety-first.
  if (status === "suspicious") return "informational";
    // Exception: view-only bank/credit-card notices are informational, not action-required
  const isBankish = category === "bank" || category === "credit_card";
  if (isBankish && looksLikeViewOnlyAccountNotice(rawText)) return "informational";


  const actionableCats = new Set([
    "utility",
    "medical",
    "insurance",
    "debt_collection",
    "government",
    "employment",
    "school",
    "legal",
    "bank",
    "credit_card",
  ]);

  const isActionable = actionableCats.has(String(category || ""));
  const confidentEnough = catConf === "high" || catConf === "medium";

    // ✅ NEW: utility bills/statements should stay action_required even if model confidence is low
  if (String(category) === "utility" && looksLikeBillOrStatement(rawText)) {
    return "action_required";
  }

  // ✅ Priority rule: if actionable with medium/high confidence, never let offer logic override steps.
  if (isActionable && confidentEnough) return "action_required";

  // Offer detection should NOT rely on model's category; use deterministic patterns.
  const combined =
    String(rawText || "") +
    "\n" +
    String(result?.plain_language_summary || "") +
    "\n" +
    String(result?.what_this_means_for_you || "");

  if (looksLikeOffer(combined)) return "offer";

  return "informational";
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
      return res.status(400).json({
        error: "Text is too short. Please provide more of the document.",
      });
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
          {
            role: "system",
            content:
              language === "es"
                ? "OUTPUT LANGUAGE REQUIREMENT: Write 100% of all user-visible text in Spanish (Español). Do not include English sentences or mixed-language text in any field. This includes summaries, meanings, steps, red flags, scripts, and safety notes."
                : "OUTPUT LANGUAGE REQUIREMENT: Write 100% of all user-visible text in English. Do not include Spanish sentences or mixed-language text in any field. This includes summaries, meanings, steps, red flags, scripts, and safety notes.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
      OPENAI_TIMEOUT_MS
    );

    const raw = completion.choices?.[0]?.message?.content || "";
    if (!raw) return res.status(500).json({ error: "Empty AI response." });

    let json: any;
    try {
      json = JSON.parse(raw);

      // Normalize confidence fields to schema enums (pre-parse)
      try {
        if (json?.document_type) json.document_type.confidence = toConfidenceEnum(json.document_type.confidence);
        if (json?.legitimacy_assessment) json.legitimacy_assessment.confidence = toConfidenceEnum(json.legitimacy_assessment.confidence);
      } catch {
        // ignore
      }
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON." });
    }

    const parsed = DoculeaResponseSchema.safeParse(json);
    if (!parsed.success) {
      if (DEBUG) {
        return res.status(500).json({
          error: "AI output failed schema validation.",
          details: parsed.error.format(),
        });
      }
      return res.status(500).json({ error: "AI output failed schema validation." });
    }

    let result = parsed.data as DoculeaResponse;

    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(500).json({ error: "AI output missing minimum step-by-step actions." });
    }

    result = renumberSteps(result);

    // ✅ Safety layers (order matters)
    result = applyHardSafetyOverride(result, trimmedText, language);

    if (result?.legitimacy_assessment?.status === "suspicious") {
  const { bucket, category } = mapOutputToBucket(result);
  const ui_action_type = "informational";
  return res.status(200).json({ ...result, ui_action_type, bucket, category });
}
    result = applyGovernmentSolicitationOverride(result, trimmedText, language);
    result = applyEcommerceNormalizationOverride(result, trimmedText, language);

    // Form mode (gated properly)
    result = applyFormGuidanceOverride(result as any, trimmedText, language) as DoculeaResponse;

    // Intent / pressure normalization (prevents “sign up / call now” harm)
    result = applyIntentAndPressureOverride(result, trimmedText, language);
    result = applyUserDemandOverride(result, trimmedText, language);

    // Extra safety: avoid scripts for suspicious/unclear
    const st = result?.legitimacy_assessment?.status;
    if (st === "suspicious" || st === "unclear") {
      (result as any).suggested_scripts = { call_script: null, email_template: null };
    }

    // ✅ Restore deterministic offer handling + UI action gating
    const ui_action_type = deriveUiActionType(result, trimmedText);
    (result as any).ui_action_type = ui_action_type;

    if (ui_action_type === "offer") {
      result = sanitizeOfferOutput(result as any, language) as DoculeaResponse;
    }

    const { bucket, category } = mapOutputToBucket(result);

    return res.status(200).json({ ...result, ui_action_type, bucket, category });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}




