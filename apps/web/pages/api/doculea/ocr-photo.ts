import type { NextApiRequest, NextApiResponse } from "next";
import formidable from "formidable";
import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";
import sharp from "sharp";
import path from "path";

export const config = {
  api: { bodyParser: false },
};

type UploadFile = {
  filepath: string;
  mimetype?: string | null;
  originalFilename?: string | null;
  size?: number;
};

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

function scoreOcrText(raw: string) {
  const text = (raw || "").trim();
  const charCount = text.length;
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, "");
  const printableRatio = charCount === 0 ? 0 : printable.length / charCount;

  const oneCharWords = words.filter((w) => w.length === 1).length;
  const oneCharRatio = wordCount === 0 ? 1 : oneCharWords / wordCount;

  const ok = charCount >= 200 && wordCount >= 40 && printableRatio >= 0.85 && oneCharRatio <= 0.25;

  const hints: string[] = [];
  if (charCount < 200 || wordCount < 40) hints.push("Move closer so text fills the frame");
  if (printableRatio < 0.85) hints.push("Increase lighting and avoid glare");
  if (oneCharRatio > 0.25) hints.push("Hold the phone flat (avoid angle/tilt)");

  return { ok, score: Number(((Math.min(charCount / 1200, 1) * 0.6) + printableRatio * 0.4).toFixed(2)), hints, text };
}

function parseMultipart(req: NextApiRequest): Promise<{ buffer: Buffer; mimetype?: string; filename?: string }> {
  const form = formidable({ multiples: false, maxFileSize: 8 * 1024 * 1024 });

  return new Promise((resolve, reject) => {
    form.parse(req, async (err: any, _fields: any, files: any) => {
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

// Cache worker + serialize OCR calls (important in serverless)
let workerPromise: Promise<Worker> | null = null;
let ocrMutex: Promise<any> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Base URL for fetching worker/wasm from /public (works in Vercel + local)
      const base =
        process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

      // IMPORTANT: point to NON-SIMD core hosted in /public to avoid /var/task ENOENT
      const options: any = {
        workerPath: `${base}/tesseract/worker.min.js`,
        corePath: `${base}/tesseract/tesseract-core.wasm.js`,
        // traineddata must be in apps/web/public/tessdata
        langPath: path.join(process.cwd(), "public", "tessdata"),
      };
      console.log("OCR DEPLOY MARKER", "v2-public-core-apply-options");
      console.log("OCR corePath =", options.corePath);

      // tesseract.js@5.1.1 typings vary; cast to any to ensure options are used
      const w = (await createWorker(["eng", "spa"], options)) as unknown as Worker;

      // v5 uses reinitialize in typings
      await w.reinitialize("eng+spa");

      // Optional stability
      await (w as any).setParameters?.({ preserve_interword_spaces: "1" });

      return w;
    })();
  }
  return workerPromise;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { buffer, mimetype, filename } = await parseMultipart(req);

    // HEIC/HEIF early rejection
    if (mimetype && /heic|heif/i.test(mimetype)) {
      return res.status(400).json({
        error:
          "HEIC images are not supported yet. On iPhone: Settings → Camera → Formats → Most Compatible (JPEG), then retake.",
        debug: { mimetype, filename },
      });
    }

    // Normalize image to PNG for Tesseract
    let processed: Buffer;
    try {
      processed = await sharp(buffer)
        .rotate()
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

    const run = async () => {
      const worker = await getWorker();

      // Hard timeout so Vercel doesn’t hang to 300s
      const out: any = await withTimeout((worker as any).recognize(processed), 45_000, "OCR");
      const rawText = (out && out.data && out.data.text) ? String(out.data.text) : "";

      const scored = scoreOcrText(rawText);

      return res.status(200).json({
        text: scored.text,
        quality: { ok: scored.ok, score: scored.score },
        hints: scored.hints,
      });
    };

    ocrMutex = ocrMutex.then(run, run);
    return await ocrMutex;
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "OCR server error" });
  }
}
