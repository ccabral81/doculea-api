import type { NextApiRequest, NextApiResponse } from "next";
import { list } from "@vercel/blob";

type AnyObj = Record<string, any>;

function redactPII(e: AnyObj): AnyObj {
  if (!e || typeof e !== "object") return e;
  delete e.ip;
  delete e.ua;
  delete e.xff;
  delete e.remoteAddress;
  return e;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch {
        // keep slot empty if failed
        results[idx] = undefined as any;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Auth: supports query token OR header token (Power BI can send headers too)
    const tokenQ = String(req.query.token || "");
    const tokenH = String(req.headers["x-doculea-export-token"] || "");
    const required = process.env.DOCULEA_EXPORT_TOKEN;

    if (required && tokenQ !== required && tokenH !== required) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Optional day filter: /events-export?day=2026-02-15
    const day = String(req.query.day || "").trim();
    const prefixBase = "doculea-events/";
    const prefix = day ? `${prefixBase}${day}/` : prefixBase;

    // Keep default smaller for Power BI; allow override but cap it
    const limit = Math.min(Number(req.query.limit || 500), 1000);

    // List blobs (fetch more than needed, then slice latest)
    const listed = await list({ prefix, limit: Math.min(limit * 3, 2000) });

    // Sort by uploadedAt (best for “latest events”)
    const blobs = [...listed.blobs]
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .slice(0, limit);

    // Fetch blobs in parallel (huge speed-up)
    const fetched = await mapWithConcurrency(blobs, 20, async (b) => {
      const r = await fetch(b.url, { cache: "no-store" });
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      const j = await r.json();
      return redactPII(j);
    });

    const events = fetched.filter(Boolean);

    // Sort by ts if present
    events.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(events);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to export events" });
  }
}
