import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "googleapis";

function sheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const token = String(req.headers["x-doculea-drain-token"] || "");
  if (process.env.DOCULEA_DRAIN_TOKEN && token !== process.env.DOCULEA_DRAIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const spreadsheetId = process.env.DOCULEA_SHEETS_ID!;
  const sheetName = process.env.DOCULEA_SHEETS_TAB || "events";

  const startRow = Math.max(2, Number(req.query.startRow || 2)); // skip header row
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 500)));

  const endRow = startRow + limit - 1;
  const range = `${sheetName}!A${startRow}:U${endRow}`; // A..T = 20 columns (adjust if you add more)

  const sheets = sheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = r.data.values || [];

  // Next row cursor advances by how many rows we actually got
  const nextRow = startRow + values.length;

  return res.status(200).json({ startRow, count: values.length, nextRow, values });
}