import type { Bucket } from "@docu-lea/core/mapping/filename"

// Keep this flexible: your schema may be either `legitimacy` or `legitimacy_assessment.status`
type AnyDocuLeaOutput = Record<string, any>;

function normalizeCategory(out: AnyDocuLeaOutput): string {
  // Prefer your schema’s category field if present
  const cat =
    out?.document_type?.category ??
    out?.documentType?.category ??
    out?.document_type ??
    out?.documentType ??
    out?.category;

  return typeof cat === "string" && cat.trim().length > 0 ? cat.trim().toLowerCase() : "unknown";
}

function normalizeLegitimacy(out: AnyDocuLeaOutput): "likely_legit" | "suspicious" | "unclear" {
  const raw =
    out?.legitimacy ??
    out?.legitimacy_assessment?.status ??
    out?.legitimacyAssessment?.status ??
    out?.legitimacy_status;

  const v = typeof raw === "string" ? raw.toLowerCase().trim() : "";

  if (v === "suspicious") return "suspicious";
  if (v === "likely_legit" || v === "legit" || v === "likelylegit") return "likely_legit";
  return "unclear";
}

function hasActions(out: AnyDocuLeaOutput): boolean {
  const steps = out?.step_by_step_actions ?? out?.stepByStepActions;
  return Array.isArray(steps) && steps.length > 0;
}

/**
 * Deterministic mapping (UI/storage only). Does NOT change AI logic.
 */
export function mapOutputToBucket(out: AnyDocuLeaOutput): {
  bucket: Bucket;
  category: string;
} {
  const category = normalizeCategory(out);
  const legitimacy = normalizeLegitimacy(out);

  // 1) High risk first
  if (legitimacy === "suspicious") {
    return { bucket: "URGENT", category };
  }

  // 2) Marketing/ads → junk (even if "unclear")
  // Add/remove categories as you encounter them, but keep it deterministic.
  const junkCategories = new Set(["marketing", "promo", "promotion", "advertisement", "ad", "offer"]);
  if (junkCategories.has(category)) {
    return { bucket: "JUNK", category };
  }

  // 3) If unclear → usually action (verify first)
  if (legitimacy === "unclear") {
    return { bucket: "ACTION", category };
  }

  // 4) Legit + has steps → action
  if (legitimacy === "likely_legit" && hasActions(out)) {
    return { bucket: "ACTION", category };
  }

  // 5) Otherwise legit informational
  return { bucket: "INFO", category };
}
