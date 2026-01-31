export type OcrLang = "en" | "es";

export type OcrQualityLevel = "pass" | "warn" | "fail";

export type OcrQuality = {
  level: OcrQualityLevel;
  ok: boolean; // ok = level !== "fail"
  charCount: number;
  wordCount: number;
  lineCount: number;
  phraseCount: number;
  sentenceCount: number;
  alphaRatio: number; // letters / total chars
  signalHits: string[];
};

function countWords(text: string) {
  return (text.match(/\b[\p{L}\p{N}]+\b/gu) || []).length;
}

function ratioAlpha(text: string) {
  const total = text.length || 1;
  const letters = (text.match(/\p{L}/gu) || []).length;
  return letters / total;
}

function countSentences(text: string) {
  return (text.match(/[.!?]+/g) || []).length;
}

function countPhrases(text: string) {
  return (text.match(/[.;:!?]\s|\n/g) || []).length;
}

function detectSignals(text: string): string[] {
  const t = (text || "").toLowerCase();
  const hits: string[] = [];

  const phone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text);
  const money = /\$\s?\d+(?:[.,]\d{2})?/.test(text);
  const date =
    /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b.*\b20\d{2}\b/i.test(
      text
    );

  if (phone) hits.push("phone");
  if (money) hits.push("money");
  if (date) hits.push("date");

  if (t.includes("refund") || t.includes("reembolso")) hits.push("refund");
  if (t.includes("bill") || t.includes("factura")) hits.push("bill");
  if (t.includes("credit") || t.includes("crédito") || t.includes("credito")) hits.push("credit");

  // common utility / letter signals
  if (t.includes("pseg") || t.includes("pse&g")) hits.push("utility_brand");
  if (t.includes("account") || t.includes("cuenta")) hits.push("account");
  if (t.includes("due") || t.includes("vence") || t.includes("vencimiento")) hits.push("due_date");

  return hits;
}

/**
 * Real documents often include sections OCR can't read (tiny footers, tables, screenshots, logos).
 * We "clean" by removing lines that are mostly garbage, while preserving strong numeric signal.
 */
export function cleanOcrText(raw: string): string {
  const lines = (raw || "").split(/\r?\n/);

  const cleaned = lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((l) => {
      const a = ratioAlpha(l);
      const words = countWords(l);
      const hasMoneyOrPhone =
        /\$\s?\d+(?:[.,]\d{2})?/.test(l) || /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(l);

      // Keep short but meaningful lines (e.g., "$100.00", "Call 1-800-...")
      if (hasMoneyOrPhone) return true;

      // Keep lines with some language signal
      return a >= 0.25 && words >= 2;
    });

  return cleaned.join("\n").trim();
}

export function computeOcrQuality(rawText: string, lang: OcrLang): OcrQuality {
  const raw = (rawText || "").trim();
  const cleaned = cleanOcrText(raw);

  const charCount = cleaned.length;
  const wordCount = countWords(cleaned);
  const lineCount = cleaned.split(/\r?\n/).filter(Boolean).length;
  const phraseCount = countPhrases(cleaned);
  const sentenceCount = countSentences(cleaned);
  const alphaRatio = Number(ratioAlpha(cleaned).toFixed(2));
  const signalHits = detectSignals(cleaned);

  const hasStrongSignal =
    signalHits.includes("phone") ||
    signalHits.includes("money") ||
    signalHits.length >= 2;

  // Thresholds tuned for messy letters:
  // - PASS: decent amount of clean text
  // - WARN: partial text but enough signal to help; proceed with a warning
  // - FAIL: too little usable text
  let level: OcrQualityLevel = "fail";
  if (wordCount >= 90 && alphaRatio >= 0.35) level = "pass";
  else if ((wordCount >= 40 && alphaRatio >= 0.25) || hasStrongSignal) level = "warn";
  else level = "fail";

  return {
    level,
    ok: level !== "fail",
    charCount,
    wordCount,
    lineCount,
    phraseCount,
    sentenceCount,
    alphaRatio,
    signalHits,
  };
}

export async function ocrInBrowser(file: File, lang: OcrLang): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("ocrInBrowser must run in the browser");
  }

  // Dynamic import so Next never bundles tesseract into server code
  const { createWorker } = await import("tesseract.js");

  const langs = lang === "es" ? ["spa", "eng"] : ["eng"];

  const options: any = {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/tesseract-core.wasm.js",
    langPath: "/tessdata",
  };

  // ✅ IMPORTANT: options must be the 3rd arg in v5 typings/overloads
  const worker: any = await createWorker(langs as any, undefined as any, options);

  // v5: reinitialize exists and is the safest single call
  await worker.reinitialize(langs.join("+"));

  // Light tuning for common printed letters
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: 6, // single uniform block of text
      preserve_interword_spaces: "1",
    });
  } catch {
    // ignore if unsupported in some builds
  }

  const out: any = await worker.recognize(file);

  await worker.terminate();

  return String(out?.data?.text ?? "");
}

/**
 * Backwards-compatible API used by UI.
 * Returns tri-state quality so the UI can proceed on "warn" and only block on "fail".
 */
export function isOcrTextUsable(text: string, lang: OcrLang) {
  return computeOcrQuality(text, lang);
}
