// ocr.ts — NEW version with deskew attempts + mild no-blur (best for your court notice scan)
// Changes vs your last version:
// ✅ Mild preprocess: NO blur (keeps letter edges sharp on clean scans)
// ✅ Adds rotation (deskew) attempts when OCR quality is not "pass"
// ✅ Tries up to 6 attempts total, then picks best by quality score
// ✅ Keeps your public API: ocrInBrowser(), cleanOcrText(), isOcrTextUsable(), prepareImageForOcr()

export type OcrLang = "en" | "es";
export type OcrQualityLevel = "pass" | "maybe" | "fail";

export type OcrQuality = {
  ok: boolean;
  level: OcrQualityLevel;
  charCount: number;
  wordCount: number;
  phraseCount: number;
  lineCount: number;
  letterRatio: number;
  reason?: string;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

async function fileToImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Image load failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Build a normalized canvas around a target long side (good for OCR). */
async function drawNormalizedCanvas(file: File, targetLongSide = 2600): Promise<HTMLCanvasElement> {
  const img = await fileToImage(file);

  const desired = clamp(targetLongSide, 1800, 3400);
  const longest = Math.max(img.width, img.height);
  const scale = desired / Math.max(1, longest);

  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas ctx not available");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  return canvas;
}

/** Rotate in-place-ish (returns new canvas). For small angles, keep same size and fill white. */
function rotateCanvas(src: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const rad = (degrees * Math.PI) / 180;
  const w = src.width;
  const h = src.height;

  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;

  const ctx = dst.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -w / 2, -h / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return dst;
}

async function canvasToPngFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return new File([blob], name, { type: "image/png" });
}

/** Mild preprocessing: grayscale + contrast normalize. NO blur (best for your scan). */
function preprocessCanvasMild(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let min = 255,
    max = 0;
  const lum = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const y = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    lum[p] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }

  const range = Math.max(1, max - min);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const yNorm = ((lum[p] - min) * 255) / range;
    data[i] = yNorm;
    data[i + 1] = yNorm;
    data[i + 2] = yNorm;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Aggressive preprocessing: grayscale + normalize + threshold (fallback). */
function preprocessCanvasAggressive(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let min = 255,
    max = 0;
  const lum = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const y = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    lum[p] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }

  // global mean threshold
  let sum = 0;
  for (let i = 0; i < lum.length; i++) sum += lum[i];
  const mean = sum / lum.length;

  const range = Math.max(1, max - min);
  const bias = 10;
  const thresh = mean - bias;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const yNorm = ((lum[p] - min) * 255) / range;
    const v = yNorm < thresh ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Public: prepare image for OCR.
 * Returns a base canvas so OCR can try deskew rotations without reloading the file.
 */
export async function prepareImageForOcr(file: File): Promise<{ baseCanvas: HTMLCanvasElement }> {
  const baseCanvas = await drawNormalizedCanvas(file, 2600);
  return { baseCanvas };
}

async function runRecognize(worker: any, file: File, psm: number): Promise<string> {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  const out: any = await worker.recognize(file);
  return String(out?.data?.text ?? "");
}

/**
 * OCR: tries in this order:
 * 1) mild + PSM 6 (best for your document)
 * 2) mild + PSM 4
 * 3) mild + PSM 6 with deskew angles [-1.2, +1.2]
 * 4) aggressive + PSM 6
 * 5) aggressive + PSM 4
 * Picks best by quality (level > letterRatio > wordCount > length).
 */
export async function ocrInBrowser(file: File, lang: OcrLang): Promise<string> {
  if (typeof window === "undefined") throw new Error("ocrInBrowser must run in the browser");

  const { createWorker } = await import("tesseract.js");

  const langs = lang === "es" ? ["spa", "eng"] : ["eng"];
  const options: any = {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/tesseract-core.wasm.js",
    langPath: "/tessdata",
  };

  const worker: any = await createWorker(langs as any, undefined as any, options);
  await worker.reinitialize(langs.join("+"));

  const attempts: Array<{ label: string; text: string; q: OcrQuality }> = [];

  // Base canvas
  const { baseCanvas } = await prepareImageForOcr(file);

  // Helper to run a canvas variant
  const ocrCanvas = async (canvas: HTMLCanvasElement, label: string, psm: number) => {
    const f = await canvasToPngFile(canvas, file.name.replace(/\.\w+$/, `.${label}.png`));
    const t = await runRecognize(worker, f, psm);
    const q = isOcrTextUsable(t, lang);
    attempts.push({ label: `${label}_psm${psm}`, text: t, q });
    return { t, q };
  };

  // 1) mild + psm6
  {
    const mild = preprocessCanvasMild(cloneCanvas(baseCanvas));
    const { t, q } = await ocrCanvas(mild, "mild", 6);
    if (q.level === "pass") {
      await worker.terminate();
      return cleanOcrText(t);
    }
  }

  // 2) mild + psm4
  {
    const mild = preprocessCanvasMild(cloneCanvas(baseCanvas));
    const { t, q } = await ocrCanvas(mild, "mild", 4);
    if (q.level === "pass") {
      await worker.terminate();
      return cleanOcrText(t);
    }
  }

  // 3) deskew angles (small, cheap, usually fixes the remaining typos)
  for (const angle of [-1.2, 1.2]) {
    const rotated = rotateCanvas(baseCanvas, angle);
    const mild = preprocessCanvasMild(rotated);
    const { t, q } = await ocrCanvas(mild, `mild_rot${angle}`, 6);
    if (q.level === "pass") {
      await worker.terminate();
      return cleanOcrText(t);
    }
  }

  // 4) aggressive + psm6
  {
    const bw = preprocessCanvasAggressive(cloneCanvas(baseCanvas));
    const { t, q } = await ocrCanvas(bw, "bw", 6);
    if (q.level === "pass") {
      await worker.terminate();
      return cleanOcrText(t);
    }
  }

  // 5) aggressive + psm4
  {
    const bw = preprocessCanvasAggressive(cloneCanvas(baseCanvas));
    const { t, q } = await ocrCanvas(bw, "bw", 4);
    if (q.level === "pass") {
      await worker.terminate();
      return cleanOcrText(t);
    }
  }

  await worker.terminate();

  // Pick best attempt
  const rank = (lvl: OcrQualityLevel) => (lvl === "pass" ? 2 : lvl === "maybe" ? 1 : 0);
  attempts.sort((a, b) => {
    const ra = rank(a.q.level),
      rb = rank(b.q.level);
    if (rb !== ra) return rb - ra;
    if (b.q.letterRatio !== a.q.letterRatio) return b.q.letterRatio - a.q.letterRatio;
    if (b.q.wordCount !== a.q.wordCount) return b.q.wordCount - a.q.wordCount;
    return (b.text.length || 0) - (a.text.length || 0);
  });

  const best = attempts[0]?.text ?? "";
  return cleanOcrText(best);
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * Cleaning: preserve key anchors (courts, notice, docket/case, dates, phone numbers).
 */
export function cleanOcrText(text: string): string {
  if (!text) return "";

  const isAnchor = (l: string) =>
    /\b(municipal court|superior court|chancery|family part|notice of|scheduled|appearance|docket|case|pltf|defn|county)\b/i.test(l) ||
    /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(l) ||
    /\b\.gov\b|\b\.nj\.us\b/i.test(l) ||
    /\$\s*\d+(\.\d{2})?/.test(l) ||
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(l) ||
    /\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b/.test(l);

  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  const cleaned = lines.filter((l) => {
    if (isAnchor(l)) return true;

    const alpha = (l.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
    const digits = (l.match(/[0-9]/g) || []).length;

    if (digits >= 6 && l.length <= 28) return true;

    return alpha + digits >= Math.max(4, Math.floor(l.length * 0.25));
  });

  return cleaned.join("\n").trim();
}

function computeOcrQuality(text: string): OcrQuality {
  const raw = text || "";
  const normalized = raw.replace(/\s+/g, " ").trim();

  const charCount = normalized.length;
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const lineCount = lines.length;

  const phrases = raw
    .split(/[\n\.\!\?;:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const phraseCount = phrases.length;

  const letters = (raw.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  const totalVisible = (raw.match(/[^\s]/g) || []).length || 1;
  const letterRatio = letters / totalVisible;

  let level: OcrQualityLevel = "maybe";
  let ok = true;
  let reason = "";

  if (charCount < 80 || wordCount < 12) {
    level = "fail";
    ok = false;
    reason = "too_short";
  } else if (letterRatio < 0.18 && wordCount < 35) {
    level = "fail";
    ok = false;
    reason = "too_noisy";
  } else if (letterRatio < 0.22 || wordCount < 25) {
    level = "maybe";
    ok = true;
    reason = "low_signal";
  } else {
    level = "pass";
    ok = true;
    reason = "good";
  }

  return { ok, level, charCount, wordCount, phraseCount, lineCount, letterRatio, reason };
}

export function isOcrTextUsable(text: string, _lang?: OcrLang): OcrQuality {
  return computeOcrQuality(cleanOcrText(text));
}
