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

export function cleanOcrText(text: string): string {
  if (!text) return "";
  // normalize whitespace, remove common OCR noise-only lines
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length > 0);

  // drop lines that are mostly punctuation/symbols
  const cleaned = lines.filter(l => {
    const alpha = (l.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
    const digits = (l.match(/[0-9]/g) || []).length;
    return alpha + digits >= Math.max(4, Math.floor(l.length * 0.25));
  });

  return cleaned.join("\n").trim();
}

export type OcrQualityLevel = "pass" | "maybe" | "fail";

export type OcrQuality = {
  ok: boolean;
  level: OcrQualityLevel;
  charCount: number;
  wordCount: number;
  phraseCount: number;
  lineCount: number;
  letterRatio: number;
  // helpful message for debugging
  reason?: string;
};

function isAndroidUA() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

async function downscaleOnAndroid(file: File, maxSide = 2200): Promise<File> {
  if (typeof window === "undefined") return file;
  if (!isAndroidUA()) return file;

  // Only attempt on images; otherwise return as-is
  if (!file.type.startsWith("image/")) return file;

  const img = document.createElement("img");
  const url = URL.createObjectURL(file);
  img.src = url;

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Image load failed"));
  });

  URL.revokeObjectURL(url);

  const longest = Math.max(img.width, img.height);
  if (longest <= maxSide) return file;

  const scale = maxSide / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) return file;

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, "image/jpeg", 0.85)
  );

  if (!blob) return file;

  return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
}

export async function prepareImageForOcr(file: File): Promise<File> {
  // Android-only downscale; iPhone behavior unchanged
  return downscaleOnAndroid(file);
}


function computeOcrQuality(text: string): OcrQuality {
  const raw = text || "";
  const normalized = raw.replace(/\s+/g, " ").trim();

  const charCount = normalized.length;
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  const lines = (raw || "").replace(/\r/g, "").split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const lineCount = lines.length;

  // phrase-ish count: split on punctuation or newlines
  const phrases = raw
    .split(/[\n\.\!\?;:]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const phraseCount = phrases.length;

  const letters = (raw.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  const totalVisible = (raw.match(/[^\s]/g) || []).length || 1;
  const letterRatio = letters / totalVisible;

  // Heuristics:
  // - pass if enough words + letters ratio decent
  // - fail if tiny OR extremely noisy
  // - maybe in between (forms/bills often)
  let level: OcrQualityLevel = "maybe";
  let ok = true;
  let reason = "";

  if (charCount < 80 || wordCount < 12) {
    level = "fail";
    ok = false;
    reason = "too_short";
  } else if (letterRatio < 0.18 && wordCount < 35) {
    // lots of symbols and sparse letters
    level = "fail";
    ok = false;
    reason = "too_noisy";
  } else if (letterRatio < 0.22 || wordCount < 25) {
    level = "maybe";
    ok = true; // allow analyze, but UI can warn
    reason = "low_signal";
  } else {
    level = "pass";
    ok = true;
    reason = "good";
  }

  return { ok, level, charCount, wordCount, phraseCount, lineCount, letterRatio, reason };
}

export function isOcrTextUsable(text: string, _lang?: OcrLang): OcrQuality {
  // We keep lang param for compatibility; rules are language-agnostic for now.
  return computeOcrQuality(cleanOcrText(text));
}