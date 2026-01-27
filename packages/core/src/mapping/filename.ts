export type Bucket = "URGENT" | "ACTION" | "INFO" | "JUNK";

function slug(s: string, max = 28) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max) || "doc";
}

export function buildDocuLeaFilename(params: {
  bucket: Bucket;
  category: string;           // e.g. "utility"
  titleHint?: string;         // e.g. recipient/company/short subject
  id: string;                 // unique id
  ext?: "pdf" | "json";
}) {
  const { bucket, category, titleHint, id } = params;
  const ext = params.ext ?? "pdf";

  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");

  const ts = `${yyyy}-${mm}-${dd}_${hh}${mi}`;

  return `${bucket}__${slug(category, 18)}__${ts}__${slug(titleHint || "", 28)}__${id}.${ext}`;
}
