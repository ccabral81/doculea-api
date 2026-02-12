import type { NextApiRequest, NextApiResponse } from "next";
import { list } from "@vercel/blob";

type AnyObj = Record<string, any>;

function redactPII(e: AnyObj): AnyObj {
  if (!e || typeof e !== "object") return e;

  // Remove any legacy/raw fields if they exist in older blobs
  delete e.ip;
  delete e.ua;
  delete e.xff;
  delete e.remoteAddress;

  // If you ever stored precise geo, remove it from public export:
  delete e.latitude;
  delete e.longitude;
  delete e.postalCode;

  return e;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = String(req.query.token || "");
    if (process.env.DOCULEA_EXPORT_TOKEN && token !== process.env.DOCULEA_EXPORT_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const prefix = String(req.query.prefix || "doculea-events/");
    const limit = Math.min(Number(req.query.limit || 500), 2000);

    const listed = await list({ prefix, limit });

    const events: AnyObj[] = [];
    for (const b of listed.blobs) {
      try {
        const j = await fetch(b.url).then((r) => r.json());
        events.push(redactPII(j));
      } catch {
        // ignore single bad entry
      }
    }

    events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(events);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to export events" });
  }
}
