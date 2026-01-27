import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { DOCULEA_SYSTEM_PROMPT, buildDoculeaUserPrompt } from "@docu-lea/core/prompts/doculeaPrompts";
import { DoculeaResponseSchema, DoculeaResponse } from "@docu-lea/core/schema/doculeaSchema";
import { hasHardScamSignals } from "@docu-lea/core/safety/doculeaSafety";
import { mapOutputToBucket } from "@docu-lea/core/mapping/bucketMap";


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

// Generic timeout wrapper that preserves the promise type (works with OpenAI's APIPromise too)
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenAI request timed out")), ms);

    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Condense long docs to reduce latency + output truncation.
 * Keeps header + key “options/deadlines/contact” sections + tail.
 */
function condenseLongDoc(text: string) {
  const originalChars = text.length;
  if (originalChars <= CONDENSE_THRESHOLD_CHARS) {
    return { text, originalChars, usedChars: originalChars };
  }

  const head = text.slice(0, 1400);

  // Pull out lines likely to contain deadlines/options/contacts
  const lines = text.split(/\r?\n/);
  const keep: string[] = [];
  const patterns = [
    /deadline|no later than|must be received|hearing|fairness|panel|esp\b|scheduled|date\b|time\b/i,
    /claim|exclude|opt\s*out|settlement|class member|options/i,
    /www\.|http|email:|@|phone|call:|telephone|fax/i,
    /docket|case no\.|indictment|court|judge|attorney|law office/i,
    /amount|\$|pay/i,
  ];

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    if (patterns.some((p) => p.test(s))) keep.push(s);
  }

  // Deduplicate and cap
  const mid = Array.from(new Set(keep)).join("\n").slice(0, 900);
  const tail = text.slice(Math.max(0, originalChars - 1400));

  const combined = [head, mid, tail].filter(Boolean).join("\n\n").slice(0, CONDENSE_TARGET_CHARS);
  return { text: combined, originalChars, usedChars: combined.length };
}

function normalizeEnumToken(v: any, kind: "confidence" | "urgency" | "status") {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();

  if (kind === "confidence" || kind === "urgency") {
    const map: Record<string, string> = {
      high: "high",
      medium: "medium",
      low: "low",
      // Spanish fallbacks (just in case)
      alto: "high",
      alta: "high",
      medio: "medium",
      media: "medium",
      bajo: "low",
      baja: "low",
    };
    return map[s] ?? v;
  }

  // status
  const map: Record<string, string> = {
    likely_legit: "likely_legit",
    suspicious: "suspicious",
    unclear: "unclear",
    // Spanish fallbacks
    "probablemente legítimo": "likely_legit",
    "probablemente legitimo": "likely_legit",
    legit: "likely_legit",
    sospechoso: "suspicious",
    "no claro": "unclear",
    "incierto": "unclear",
  };
  return map[s] ?? v;
}

/** Normalize JSON shape and fix common drift without changing meaning. */
function normalizeDoculeaJson(j: any) {
  if (!j || typeof j !== "object") return j;

  // Ensure arrays exist
  if (!Array.isArray(j.step_by_step_actions)) j.step_by_step_actions = [];
  if (!Array.isArray(j.recommended_actions)) j.recommended_actions = [];
  if (!Array.isArray(j.red_flags)) j.red_flags = [];

  // Enums
  if (j.document_type?.confidence) j.document_type.confidence = normalizeEnumToken(j.document_type.confidence, "confidence");
  if (j.legitimacy_assessment?.status) j.legitimacy_assessment.status = normalizeEnumToken(j.legitimacy_assessment.status, "status");
  if (j.legitimacy_assessment?.confidence) j.legitimacy_assessment.confidence = normalizeEnumToken(j.legitimacy_assessment.confidence, "confidence");

  for (const step of j.step_by_step_actions) {
    if (step?.urgency) step.urgency = normalizeEnumToken(step.urgency, "urgency");
  }

  // Scripts: schema allows nullable, but if strings are present they must meet min length.
  if (!j.suggested_scripts || typeof j.suggested_scripts !== "object") {
    j.suggested_scripts = { call_script: null, email_template: null };
  } else {
    const cs = j.suggested_scripts.call_script;
    const em = j.suggested_scripts.email_template;

    if (typeof cs === "string" && cs.trim().length < 5) j.suggested_scripts.call_script = null;
    if (typeof em === "string" && em.trim().length < 5) j.suggested_scripts.email_template = null;

    if (cs === "" || cs == null) j.suggested_scripts.call_script = j.suggested_scripts.call_script ?? null;
    if (em === "" || em == null) j.suggested_scripts.email_template = j.suggested_scripts.email_template ?? null;
  }

  return j;
}

/** Ensure safety_notes passes schema (min length or null). */
function ensureSafetyNotes(json: any, lang: "en" | "es") {
  if (!json || typeof json !== "object") return json;

  const s = typeof json.safety_notes === "string" ? json.safety_notes.trim() : "";
  if (s.length >= 5) return json;

  // Schema allows nullable; however, we prefer a short non-empty note to reduce 500s.
  json.safety_notes =
    lang === "es"
      ? "Verifica siempre usando canales oficiales."
      : "Always verify using official channels.";
  return json;
}

function applyHardSafetyOverride(result: DoculeaResponse, documentText: string, lang: "en" | "es") {
  if (!hasHardScamSignals(documentText)) return result;

  result.legitimacy_assessment.status = "suspicious";
  result.legitimacy_assessment.confidence = "high";
  result.legitimacy_assessment.summary_reason =
    result.legitimacy_assessment.summary_reason ||
    (lang === "es"
      ? "El documento contiene señales de alto riesgo asociadas con estafas."
      : "The document contains high-risk scam signals.");

  const rf = new Set(result.red_flags || []);
  rf.add(
    lang === "es"
      ? "Contiene indicadores de estafa (p. ej., tarjetas de regalo/cripto/arresto/SSN/códigos)."
      : "Contains scam indicators (e.g., gift cards/crypto/arrest/SSN/codes)."
  );
  result.red_flags = Array.from(rf);

  const safetyStep = {
    step: 1,
    title: lang === "es" ? "No respondas ni compartas información" : "Do not respond or share information",
    description:
      lang === "es"
        ? "No hagas clic en enlaces, no llames números del documento y no compartas datos personales o financieros."
        : "Do not click links, call numbers in the document, or share personal/financial details.",
    urgency: "high" as const,
  };

  //const rest = (result.step_by_step_actions || [])
    .filter((s) => s.step !== 1)
    .slice(0, 5)
    .map((s, idx) => ({ ...s, step: idx + 2 }));

  result.step_by_step_actions = [safetyStep, ...rest].slice(0, 6);
  return result;
}

function renumberSteps(result: DoculeaResponse) {
  result.step_by_step_actions = (result.step_by_step_actions || [])
    .slice(0, 6)
    .map((s, idx) => ({ ...s, step: idx + 1 }));
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

    if (trimmedText.length < 20) {
      return res.status(400).json({ error: "documentText is too short (min 20 characters)." });
    }

    if (trimmedText.length > MAX_CHARS) {
      return res.status(400).json({ error: `documentText is too long (max ${MAX_CHARS} characters).` });
    }

    const language: "en" | "es" = lang === "es" ? "es" : "en";

    // Condense locally (no extra AI call)
    const condensed = condenseLongDoc(trimmedText);
    if (DEBUG && condensed.originalChars !== condensed.usedChars) {
      console.log("DOCULEA_CONDENSED:", { originalChars: condensed.originalChars, usedChars: condensed.usedChars });
    }

    const userPrompt = buildDoculeaUserPrompt(condensed.text, language);

   const create = (openai.chat.completions.create as any).bind(openai.chat.completions);

    // Attempt 1 (JSON mode)
    const r1 = await withTimeout<any>(
      create({
        model: "gpt-4.1-mini",
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

    const text1: string = r1?.choices?.[0]?.message?.content ?? "";
    if (DEBUG) console.log("DOCULEA_RAW_TEXT_1:", text1);

    let parsed = (() => {
      try {
        let json1 = JSON.parse(text1);
        json1 = ensureSafetyNotes(normalizeDoculeaJson(json1), language);
        const out = DoculeaResponseSchema.safeParse(json1);
        if (!out.success && DEBUG) console.log("DOCULEA_ZOD_ERRORS_1:", out.error.issues);
        return out;
      } catch (e: any) {
        if (DEBUG) console.log("DOCULEA_PARSE_ERR_1:", e?.message);
        return { success: false } as const;
      }
    })();

    // Retry once if invalid (still JSON mode, same prompt + stricter reminder)
    if (!parsed.success) {
      const retry = `
FORMAT ERROR.
Return ONLY a single valid JSON object that matches the REQUIRED JSON SCHEMA exactly.
No extra keys. No renamed keys. No text outside JSON.
Remember: enum tokens stay in English ("high|medium|low", "likely_legit|suspicious|unclear").
safety_notes must be a non-empty sentence (>= 20 chars).
`.trim();

      const r2 = await withTimeout<any>(
        create({
          model: "gpt-4.1-mini",
          temperature: 0,
          max_tokens: OPENAI_MAX_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: DOCULEA_SYSTEM_PROMPT },
            { role: "user", content: `${userPrompt}\n\n${retry}` },
          ],
        }),
        OPENAI_TIMEOUT_MS
      );

      const text2: string = r2?.choices?.[0]?.message?.content ?? "";
      if (DEBUG) console.log("DOCULEA_RAW_TEXT_2:", text2);

      const parsed2 = (() => {
        try {
          let json2 = JSON.parse(text2);
          json2 = ensureSafetyNotes(normalizeDoculeaJson(json2), language);
          const out = DoculeaResponseSchema.safeParse(json2);
          if (!out.success && DEBUG) console.log("DOCULEA_ZOD_ERRORS_2:", out.error.issues);
          return out;
        } catch (e: any) {
          if (DEBUG) console.log("DOCULEA_PARSE_ERR_2:", e?.message);
          return { success: false } as const;
        }
      })();

      if (!parsed2.success) {
        return res.status(500).json({ error: "AI output validation failed." });
      }

      parsed = parsed2;
    }

    let result = parsed.data as DoculeaResponse;

    // Guard minimum steps (schema already enforces, but keep explicit)
    if (!result.step_by_step_actions || result.step_by_step_actions.length < 2) {
      return res.status(500).json({ error: "AI output missing minimum step-by-step actions." });
    }

    // Normalize step numbering
    result = renumberSteps(result);

    // Apply hard safety overrides (use original text for scam signals)
    result = applyHardSafetyOverride(result, trimmedText, language);

    const { bucket, category } = mapOutputToBucket(result);

    // Attach namespaced metadata (safe, non-invasive)
    (result as any)._doculea = {
      bucket,
      category,
    };

    return res.status(200).json(result);
  } catch (err: any) {
    if (err?.message === "OpenAI request timed out") {
      return res.status(504).json({ error: "The analysis took too long. Please try again." });
    }
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
