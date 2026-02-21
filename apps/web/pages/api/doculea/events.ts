import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "googleapis";
import { randomUUID } from "crypto";

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function toPipeList(v: any): string {
  if (!Array.isArray(v) || v.length === 0) return "";
  return v.map(String).join("|");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const ts = new Date().toISOString();

    // ---- KEEP YOUR EXISTING GEO/IP HASH LOGIC HERE ----
    // Example placeholders:
    const country = body?.country || null;
    const region = body?.region || null;
    const city = body?.city || null;
    const postalCode = body?.postalCode || null;
    const latitude = body?.latitude || null;
    const longitude = body?.longitude || null;
    const ipHash = body?.ip_hash || null;

    const payload = {
      id: randomUUID(),
      ts,
      event: body?.event || null,
      sessionId: body?.sessionId || null,
      lang: body?.lang || null,
      device: body?.device || null,
      route: body?.route || null,
      docType: body?.docType || null,
      status: body?.status || null,
      confidence: body?.confidence || null,
      ip_hash: ipHash,
      quality_flags: body?.quality_flags ?? null,
      overrides: body?.overrides ?? null,
      country,
      region,
      city,
      postalCode,
      latitude,
      longitude,
      v: 2,
    };

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
    ];

    const spreadsheetId = process.env.DOCULEA_SHEETS_ID!;
    const sheetName = process.env.DOCULEA_SHEETS_TAB || "events";

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