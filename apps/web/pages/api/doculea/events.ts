import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "googleapis";
import crypto from "node:crypto";
import { randomUUID } from "crypto";

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return null;
}

function ipHash(ip: string | null): string | null {
  if (!ip) return null;
  const secret = process.env.DOCULEA_IP_HASH_SECRET;
  if (!secret) return null;
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
  return { country, region, city, postalCode, latitude, longitude };
}

function toPipeList(v: any): string {
  if (!Array.isArray(v) || v.length === 0) return "";
  return v.map(String).join("|");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Keep your PowerShell bypass (important)
  if (req.headers["user-agent"]?.includes("PowerShell")) {
    return res.status(200).json({ ok: true, skipped: "powershell" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const ts = new Date().toISOString();

    const sessionId = String(body?.sessionId || "unknown");
    const event = String(body?.event || "unknown");

    const ip = getClientIp(req);
    const geo = getGeo(req);

    const payload = {
      id: randomUUID(),
      ts,
      event,
      sessionId,
      lang: body?.lang || null,
      device: body?.device || null,
      route: body?.route || null,

      docType: body?.docType || null,
      status: body?.status || null,
      confidence: body?.confidence || null,

      ocr: body?.ocr || null,
      overrides: body?.overrides ?? null,
      quality_flags: body?.quality_flags ?? null,

      country: geo.country,
      region: geo.region,
      city: geo.city,
      postalCode: geo.postalCode,
      latitude: geo.latitude,
      longitude: geo.longitude,
      ip_hash: ipHash(ip),

      v: 2,
    };

    // Sheet row (match your header order)
    const row = [
      payload.id,
      payload.ts,
      payload.event,
      payload.sessionId,
      payload.lang,
      payload.device,
      payload.route,
      payload.docType,
      payload.status,
      payload.confidence,
      payload.ip_hash,
      toPipeList(payload.quality_flags),
      payload.overrides ? JSON.stringify(payload.overrides) : "",
      payload.country,
      payload.region,
      payload.city,
      payload.postalCode,
      payload.latitude,
      payload.longitude,
      payload.v,
      payload.ocr ? JSON.stringify(payload.ocr) : "",
    ];

    const spreadsheetId = process.env.DOCULEA_SHEETS_ID;
    const sheetName = process.env.DOCULEA_SHEETS_TAB || "events";
    if (!spreadsheetId) return res.status(500).json({ error: "Missing DOCULEA_SHEETS_ID" });

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("Sheets logging error:", e);
    return res.status(500).json({ error: e?.message || "Failed to log event" });
  }
}