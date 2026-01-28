export type OcrLang = "en" | "es";

export async function ocrInBrowser(file: File, lang: OcrLang): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("ocrInBrowser must run in the browser");
  }

  // Dynamic import so Next never bundles this into server code
  const { createWorker } = await import("tesseract.js");

  const langs = lang === "es" ? ["spa", "eng"] : ["eng"];

  const worker: any = await createWorker(langs, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/tesseract-core.wasm.js",
    langPath: "/tessdata",
  });

  await worker.reinitialize(langs.join("+"));

  const out: any = await worker.recognize(file);

  await worker.terminate();

  return String(out?.data?.text ?? "");
}

export function isOcrTextUsable(text: string) {
  const t = (text || "").trim();
  const charCount = t.length;
  const words = t.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // very simple gate for MVP
  const ok = charCount >= 200 && wordCount >= 40;
  return { ok, charCount, wordCount };
}
