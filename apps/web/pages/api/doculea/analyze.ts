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
import { applyHardSafetyOverride } from "../../../../../packages/core/src/safety/doculeaSafety";
import { mapOutputToBucket } from "../../../../../packages/core/src/mapping/bucketMap";

function toConfidenceEnum(v: any): "high" | "medium" | "low" {
  if (v === "high" || v === "medium" || v === "low") return v;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "medium";
  if (n >= 0.8) return "high";
  if (n >= 0.5) return "medium";
  return "low";
}


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
  const v = String(input ?? "").toLowerCase().trim();
  if (v === "es" || v.startsWith("es-") || v === "spanish" || v === "espanol" || v === "español") return "es";
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


type UiActionType = "action_required" | "informational" | "offer";

function deriveUiActionType(result: any): UiActionType {
  const category = result?.document_type?.category;
  const status = result?.legitimacy_assessment?.status;

  // suspicious -> treat as informational (no direct actions that contact unknown parties)
  if (status === "suspicious") return "informational";

  // obvious offers/promos
  if (category === "credit_card") return "offer";
  if (category === "bank" && (!result?.recommended_actions || result.recommended_actions.length === 0)) return "offer";

  // usually actionable
  if (["utility", "medical", "insurance", "debt_collection", "government", "employment", "school"].includes(category)) {
    return "action_required";
  }

  return "informational";
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
              "Si te interesa, busca la empresa por tu cuenta (sitio oficial desde búsqueda/BBB) y compara alternativas antes de tomar una decisión.",
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
              "If you want it, look up the company independently (official website via search/BBB) and compare alternatives before deciding.",
            urgency: "low",
          },
        ];

  result.step_by_step_actions = safeSteps;

  // Do NOT encourage contact/purchase for offers
  result.recommended_actions = [];

  // Remove scripts (empty strings keep schema happy)
  result.suggested_scripts = { call_script: "", email_template: "" };

  const extraSafety =
    language === "es"
      ? "Nota: Para ofertas, evita llamar números o visitar enlaces impresos en la carta. Si decides investigar, busca la empresa por tu cuenta."
      : "Note: For offers, avoid calling numbers or clicking links printed on the letter. If you investigate, look up the company independently.";

  result.safety_notes = result.safety_notes ? `${result.safety_notes}\n\n${extraSafety}` : extraSafety;

  if (!Array.isArray(result.red_flags)) result.red_flags = [];
  if (language === "es") {
    if (!result.red_flags.includes("Es una oferta/promoción: no es obligatorio inscribirse.")) {
      result.red_flags.unshift("Es una oferta/promoción: no es obligatorio inscribirse.");
    }
  } else {
    if (!result.red_flags.includes("This is an offer/promotion: you are not required to sign up.")) {
      result.red_flags.unshift("This is an offer/promotion: you are not required to sign up.");
    }
  }

  return result;
}


// ✅ one-shot repair retry when JSON shape is almost right but fails Zod
async function repairToSchemaOnce(args: {
  rawJson: any;
  zodFormattedError: any;
  language: "en" | "es";
}) {
  const { rawJson, zodFormattedError } = args;

  const repairPrompt =
    `You previously returned JSON that failed validation.\n\n` +
    `Fix the JSON to match the required schema exactly.\n` +
    `- Keep meaning the same\n` +
    `- Do not add commentary\n` +
    `- Return ONLY a JSON object\n\n` +
    `Validation errors (Zod format):\n${JSON.stringify(zodFormattedError, null, 2)}\n\n` +
    `Previous JSON:\n${JSON.stringify(rawJson, null, 2)}\n`;

  const completion = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: OPENAI_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DOCULEA_SYSTEM_PROMPT },
        { role: "user", content: repairPrompt },
      ],
    }),
    OPENAI_TIMEOUT_MS
  );

  const raw = completion.choices?.[0]?.message?.content || "";
  if (!raw) throw new Error("Empty AI repair response.");

  return JSON.parse(raw);
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

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return res.status(422).json({ error: "AI returned invalid JSON." });
    }

// Normalize confidence fields to schema enums (pre-parse)
try {
  if (json?.document_type) {
    json.document_type.confidence = toConfidenceEnum(json.document_type.confidence);
  }
  if (json?.legitimacy_assessment) {
    json.legitimacy_assessment.confidence = toConfidenceEnum(json.legitimacy_assessment.confidence);
  }
} catch {
  // ignore — parse will catch missing shape
}


    // First validation
    let parsed = DoculeaResponseSchema.safeParse(json);

    // ✅ Minimal fix: one repair retry ONLY if schema fails
    if (!parsed.success) {
      try {
        const repaired = await repairToSchemaOnce({
          rawJson: json,
          zodFormattedError: parsed.error.format(),
          language,
        });
        parsed = DoculeaResponseSchema.safeParse(repaired);
        if (!parsed.success) {
          const err = parsed.error!;
          return res.status(422).json({
            error: "AI output failed schema validation.",
            ...(DEBUG ? { details: err.format() } : {}),
          });
        }

      } catch (e: any) {
        const err = parsed.error!; // from the first failure
        return res.status(422).json({
          error: "AI output failed schema validation.",
          ...(DEBUG ? { details: err.format(), repair_error: e?.message } : {}),
        });
      }

    }

    let result = parsed.data as DoculeaResponse;

    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(422).json({ error: "AI output missing minimum step-by-step actions." });
    }

    result = renumberSteps(result);

    // Apply hard safety overrides (use original text for scam signals)
    result = applyHardSafetyOverride(result, trimmedText, language);

    const ui_action_type = deriveUiActionType(result);
    (result as any).ui_action_type = ui_action_type;

    if (ui_action_type === "offer") {
      result = sanitizeOfferOutput(result, language);
    }


    const { bucket, category } = mapOutputToBucket(result);

    return res.status(200).json({ ...result, bucket, category });
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}



