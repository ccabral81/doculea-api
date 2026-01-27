import type { DoculeaResponse }from "@docu-lea/core/schema/doculeaSchema";

/**
 * Detects strong scam indicators in raw text.
 * This does NOT modify output by itself.
 */
export function hasHardScamSignals(text: string): boolean {
  const t = (text || "").toLowerCase();
  const patterns = [
    "gift card",
    "giftcard",
    "crypto",
    "bitcoin",
    "wire transfer",
    "western union",
    "moneygram",
    "arrest",
    "warrant",
    "police",
    "ssn",
    "social security",
    "verification code",
    "one-time code",
    "otp",
  ];
  return patterns.some(p => t.includes(p));
}

/**
 * Enforces hard safety overrides on an already-valid AI result.
 * MUST ALWAYS return a DoculeaResponse.
 * DOES NOT change AI logic, only applies safety guardrails.
 */
export function applyHardSafetyOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  // If no hard scam signals, return result untouched
  if (!hasHardScamSignals(rawText)) {
    return result;
  }

  // Force scam classification if hard signals exist
  return {
    ...result,
    document_type: {
      category: "scam",
      confidence: "high",
    },
    legitimacy_assessment: {
      status: "suspicious",
      confidence: "high",
      summary_reason:
        language === "es"
          ? "El documento contiene señales claras de estafa, como solicitudes de pago inusuales o amenazas."
          : "The document contains strong scam indicators such as unusual payment requests or threats.",
    },
    safety_notes:
      language === "es"
        ? "No realice pagos, no comparta información personal y no responda a este mensaje."
        : "Do not make payments, do not share personal information, and do not respond to this message.",
  };
}
