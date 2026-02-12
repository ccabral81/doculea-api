import type { NextApiRequest, NextApiResponse } from "next";
import { put } from "@vercel/blob";
import crypto from "node:crypto";

function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return null;
}

function ipHash(ip: string | null): string | null {
  if (!ip) return null;
  const secret = process.env.DOCULEA_IP_HASH_SECRET;
  if (!secret) return null;

  // HMAC is better than plain hash (prevents rainbow-table reversal)
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

function getGeo(req: NextApiRequest) {
  // Provided by Vercel at request-time (may be missing in local dev)
  const country = String(req.headers["x-vercel-ip-country"] || "unknown");
  const region = String(req.headers["x-vercel-ip-country-region"] || "unknown");
  const city = String(req.headers["x-vercel-ip-city"] || "unknown");
  const postalCode = String(req.headers["x-vercel-ip-postal-code"] || "unknown");
  const latitude = String(req.headers["x-vercel-ip-latitude"] || "unknown");
  const longitude = String(req.headers["x-vercel-ip-longitude"] || "unknown");
  return { country, region, city,postalCode,latitude,longitude };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);

    const sessionId = String(body?.sessionId || "unknown");
    const event = String(body?.event || "unknown");

    const ip = getClientIp(req);
    const { country, region, city,postalCode, latitude,longitude} = getGeo(req);

    // Minimal privacy: DO NOT store document text, DO NOT store raw IP
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

      // geo + hashed IP (no raw ip)
      country,
      region,
      city,
      postalCode,
      latitude,
      longitude,
      ip_hash: ipHash(ip),

      v: 2,
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
