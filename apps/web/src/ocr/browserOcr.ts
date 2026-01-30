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

  // OCR tuning for documents
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: 6, // Assume a block of text
      preserve_interword_spaces: "1",
    } as any);
  } catch {
    // ignore if not supported
  }

  const out: any = await worker.recognize(file);

  await worker.terminate();

  return String(out?.data?.text ?? "");
}



export function computeOcrQuality(text: string) {
  const t = (text || "").trim();

  const charCount = t.length;

  const words = t.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lineCount = lines.length;

  // "Phrase" = a line with at least 3 words (useful for letters/forms)
  const phraseCount = lines.filter((l) => l.split(/\s+/).filter(Boolean).length >= 3).length;

  // Rough sentence count
  const sentenceCount = t.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;

  // How much of the text looks like real letters/numbers vs noise
  const alphaNum = (t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const alphaRatio = charCount > 0 ? alphaNum / charCount : 0;

  const avgWordLen = wordCount > 0 ? words.reduce((a, w) => a + w.length, 0) / wordCount : 0;

  return {
    charCount,
    wordCount,
    lineCount,
    phraseCount,
    sentenceCount,
    alphaRatio,
    avgWordLen,
  };
}

export function isOcrTextUsable(text: string) {
  const q = computeOcrQuality(text);

  // Balanced quality gate:
  // - Enough content AND
  // - Enough "phrases" (real lines) AND
  // - Not mostly gibberish
  const ok =
    (q.charCount >= 200 && q.wordCount >= 35 && q.phraseCount >= 3 && q.alphaRatio >= 0.55) ||
    (q.charCount >= 450 && q.wordCount >= 60 && q.alphaRatio >= 0.5);

  return { ok, ...q };
}
