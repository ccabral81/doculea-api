import type { NextApiRequest, NextApiResponse } from "next";
import formidable from "formidable";
import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";
import sharp from "sharp";
import path from "path";

export const config = {
  api: { bodyParser: false }, // REQUIRED for multipart
};

type UploadFile = {
  filepath: string;
  mimetype?: string | null;
  originalFilename?: string | null;
  size?: number;
};

// -----------------------------
// Deterministic OCR quality gate
// -----------------------------
function scoreOcrText(raw: string) {
  const text = (raw || "").trim();

  const charCount = text.length;
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, "");
  const printableRatio = charCount === 0 ? 0 : printable.length / charCount;

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lineCount = lines.length;

  const oneCharWords = words.filter((w) => w.length === 1).length;
  const oneCharRatio = wordCount === 0 ? 1 : oneCharWords / wordCount;

  let score = 0;
  score += Math.min(charCount / 1200, 1) * 0.45;
  score += Math.min(wordCount / 250, 1) * 0.25;
  score += printableRatio * 0.2;
  score += Math.min(lineCount / 30, 1) * 0.1;

  const reasons: string[] = [];
  if (charCount < 200) reasons.push("too_short");
  if (wordCount < 40) reasons.push("too_few_words");
  if (printableRatio < 0.85) reasons.push("noisy_text");
  if (oneCharRatio > 0.25) reasons.push("likely_bad_ocr");

  const ok = reasons.length === 0 && score >= 0.55;

  const hints: string[] = [];
  if (charCount < 200 || wordCount < 40) hints.push("Move closer so text fills the frame");
  if (printableRatio < 0.85) hints.push("Increase lighting and avoid glare");
  if (oneCharRatio > 0.25) hints.push("Hold the phone flat (avoid angle/tilt)");

  return { ok, score: Number(score.toFixed(2)), reasons, hints, text };
}

// ---------------
// Timeout helper
// ---------------
function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// ---------------
// Multipart parser (typed)
// ---------------
function parseMultipart(
  req: NextApiRequest
): Promise<{ buffer: Buffer; mimetype?: string; filename?: string }> {
  const form = formidable({ multiples: false, maxFileSize: 8 * 1024 * 1024 });

  return new Promise((resolve, reject) => {
    form.parse(req, async (err: Error | null, _fields: any, files: any) => {
      if (err) return reject(err);

      const picked = (files.image ?? files.file) as UploadFile | UploadFile[] | undefined;
      const f = Array.isArray(picked) ? picked[0] : picked;
      if (!f) return reject(new Error("Missing image field (expected 'image')."));

      const fs = await import("fs/promises");
      const buffer = await fs.readFile(f.filepath);

      resolve({
        buffer,
        mimetype: f.mimetype ?? undefined,
        filename: f.originalFilename ?? undefined,
      });
    });
  });
}

// -------------------------
// Tesseract worker (cached + mutex)
// -------------------------
let workerPromise: Promise<Worker> | null = null;
let ocrMutex: Promise<any> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // IMPORTANT: use the signature that matches your installed typings:
      // createWorker(langs, options)
      const w = await createWorker("eng+spa", {
        // Serverless-safe: point to concrete assets
        workerPath: require.resolve("tesseract.js/dist/worker.min.js"),
        corePath: require.resolve("tesseract.js-core/tesseract-core.wasm.js"),

        // Traineddata served from /public
        langPath: path.join(process.cwd(), "public", "tessdata"),
      } as any);

      // Your typings show `reinitialize` exists, but not `initialize/loadLanguage`.
      // This ensures the language is active.
      await w.reinitialize("eng+spa");

      // Optional stability
      await (w as any).setParameters?.({
        preserve_interword_spaces: "1",
      });

      return w as unknown as Worker;
    })();
  }
  return workerPromise;
}


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { buffer, mimetype, filename } = await parseMultipart(req);

    // 1) Reject unsupported formats early (HEIC/HEIF)
    if (mimetype && /heic|heif/i.test(mimetype)) {
      return res.status(400).json({
        error:
          "HEIC images are not supported yet. Please retake the photo with iPhone camera setting 'Most Compatible' (JPEG).",
      });
    }

    // 2) Normalize to PNG so Tesseract can always read it
    let processed: Buffer;
    try {
      processed = await sharp(buffer)
        .rotate() // respect EXIF
        .grayscale()
        .normalize()
        .resize({ width: 1800, withoutEnlargement: true })
        .toFormat("png")
        .toBuffer();
    } catch (e: any) {
      return res.status(400).json({
        error: `Could not process image. Upload a clear JPG/PNG photo. (${e?.message || "sharp error"})`,
        debug: { mimetype, filename },
      });
    }

    // 3) Serialize OCR calls (prevents concurrent worker issues)
    const run = async () => {
      const worker = await getWorker();

      // HARD TIMEOUT so Vercel doesn't hang until 300s
      const out = await withTimeout(worker.recognize(processed), 45_000, "OCR");

      const rawText = out?.data?.text || "";
      const scored = scoreOcrText(rawText);

      return res.status(200).json({
        text: scored.text,
        quality: { ok: scored.ok, score: scored.score, reasons: scored.reasons },
        hints: scored.hints,
      });
    };

    ocrMutex = ocrMutex.then(run, run);
    return await ocrMutex;
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "OCR server error" });
  }
}
