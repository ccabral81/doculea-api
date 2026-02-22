import { google } from "googleapis";

function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL!;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

export async function appendDoculeaEventRow(row: (string | number | null)[]) {
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
}