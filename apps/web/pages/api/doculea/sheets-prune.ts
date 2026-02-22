import type { NextApiRequest, NextApiResponse } from "next";
import { google } from "googleapis";

async function getSheetId(spreadsheetId: string, title: string, sheetsApi: any): Promise<number> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find((s: any) => s.properties?.title === title);
  if (!sheet) throw new Error(`Sheet tab not found: ${title}`);
  return sheet.properties.sheetId;
}

function sheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = String(req.headers["x-doculea-drain-token"] || "");
  if (process.env.DOCULEA_DRAIN_TOKEN && token !== process.env.DOCULEA_DRAIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const upToRow = Number(req.body?.upToRow || 0);
  if (!Number.isFinite(upToRow) || upToRow < 2) {
    return res.status(400).json({ error: "upToRow must be >= 2" });
  }

  const spreadsheetId = process.env.DOCULEA_SHEETS_ID!;
  const sheetName = process.env.DOCULEA_SHEETS_TAB || "events";

  const sheets = sheetsClient();
  const sheetId = await getSheetId(spreadsheetId, sheetName, sheets);

  // Google Sheets API uses 0-based indices, endIndex exclusive
  // We want delete rows 2..upToRow (1-based) => indices 1..upToRow-1
  const startIndex = 1;              // row 2
  const endIndex = upToRow;          // exclusive => deletes through upToRow

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex,
            },
          },
        },
      ],
    },
  });

  return res.status(200).json({ ok: true, deletedThroughRow: upToRow });
}