export type OcrLang = "en" | "es";

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

  const out: any = await worker.recognize(file);

  await worker.terminate();

  return String(out?.data?.text ?? "");
}




export type OcrQualityLevel = "pass" | "warn" | "fail";

export type OcrQuality = {
  level: OcrQualityLevel;
  ok: boolean;
  charCount: number;
  wordCount: number;
  lineCount: number;
  phraseCount: number;
  sentenceCount: number;
  alphaRatio: number;
  signalHits: string[];
};

function countWords(text: string) {
  return (text.match(/\b[\p{L}\p{N}]+\b/gu) || []).length;
}

function alphaRatio(text: string) {
  const total = text.length || 1;
  const letters = (text.match(/\p{L}/gu) || []).length;
  return letters / total;
}

function countLines(text: string) {
  return (text || "").split(/\r?\n/).filter(Boolean).length;
}

function countPhrases(text: string) {
  return (text.match(/[.;:!?]\s|\n/gu) || []).length;
}

function countSentences(text: string) {
  return (text.match(/[.!?]+/g) || []).length;
}

export function cleanOcrText(raw: string): string {
  const lines = (raw || "").split(/\r?\n/);
  const cleaned = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const a = alphaRatio(l);
      const words = countWords(l);
      const hasMoneyOrPhone =
        /\$\s?\d+(?:[.,]\d{2})?/.test(l) ||
        /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(l) ||
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(l);
      return hasMoneyOrPhone || (a >= 0.25 && words >= 2);
    });

  return cleaned.join("\n").replace(/[ \t]{2,}/g, " ").trim();
}

function detectSignals(text: string): string[] {
  const t = (text || "").toLowerCase();
  const hits: string[] = [];

  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) hits.push("phone");
  if (/\$\s?\d+(?:[.,]\d{2})?/.test(text)) hits.push("money");
  if (/\b20\d{2}\b/.test(text) && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(t)) hits.push("date");

  if (t.includes("refund") || t.includes("reembolso")) hits.push("refund");
  if (t.includes("bill") || t.includes("factura")) hits.push("bill");
  if (t.includes("credit") || t.includes("crédito") || t.includes("credito")) hits.push("credit");
  if (t.includes("pseg") || t.includes("pse&g") || t.includes("pse g")) hits.push("utility_brand");

  return hits;
}

export function computeOcrQuality(rawText: string, lang: OcrLang): OcrQuality {
  const cleaned = cleanOcrText((rawText || "").trim());

  const charCount = cleaned.length;
  const wordCount = countWords(cleaned);
  const lineCount = countLines(cleaned);
  const phraseCount = countPhrases(cleaned);
  const sentenceCount = countSentences(cleaned);
  const aRatio = alphaRatio(cleaned);
  const signalHits = detectSignals(cleaned);

  const hasStrongSignal =
    signalHits.includes("phone") || signalHits.includes("money") || signalHits.length >= 2;

  let level: OcrQualityLevel = "fail";
  if (wordCount >= 90 && aRatio >= 0.35) level = "pass";
  else if ((wordCount >= 40 && aRatio >= 0.25) || hasStrongSignal) level = "warn";
  else level = "fail";

  return {
    level,
    ok: level !== "fail",
    charCount,
    wordCount,
    lineCount,
    phraseCount,
    sentenceCount,
    alphaRatio: Number(aRatio.toFixed(2)),
    signalHits,
  };
}

export function isOcrTextUsable(text: string, lang: OcrLang = "en") {
  return computeOcrQuality(text, lang);
}
