import type { NextApiRequest, NextApiResponse } from "next";
import { put } from "@vercel/blob";

function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Basic shape (keep flexible)
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);

    const sessionId = String(body?.sessionId || "unknown");
    const event = String(body?.event || "unknown");

    // Minimal privacy: DO NOT store document text
    const payload = {
      ts,
      event,
      sessionId,
      lang: body?.lang || null,
      device: body?.device || null,
      route: body?.route || null,

      // outcome (optional)
      docType: body?.docType || null,
      status: body?.status || null,
      confidence: body?.confidence || null,

      // OCR stats (optional)
      ocr: body?.ocr || null,

      // minimal metadata
      ip: getClientIp(req),
      ua: req.headers["user-agent"] || null,
      v: 1,
    };

    const safeEvent = event.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

    const filename = `${ts.replace(/[:.]/g, "-")}__${safeSession}__${safeEvent}.json`;
    const key = `doculea-events/${day}/${filename}`;

    await put(key, JSON.stringify(payload), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Event write failed" });
  }
}
