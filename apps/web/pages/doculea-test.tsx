"use client";
import React, { useMemo, useState } from "react";
import { ocrInBrowser, isOcrTextUsable } from "@/ocr/browserOcr";

type Lang = "en" | "es";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; label: string; dot: string }> = {
    likely_legit: { bg: "#16a34a", label: "Likely Legit", dot: "●" },
    unclear: { bg: "#f59e0b", label: "Unclear", dot: "●" },
    suspicious: { bg: "#dc2626", label: "Suspicious", dot: "●" },
  };
  const cfg = map[status] || { bg: "#6b7280", label: status, dot: "●" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: cfg.bg,
        color: "white",
        padding: "7px 12px",
        borderRadius: 999,
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: 0.2,
      }}
    >
      <span style={{ fontSize: 12, opacity: 0.95 }}>{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

async function normalizeToJpegIfHeic(file: File): Promise<File> {
  const isHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif");

  if (!isHeic) return file;

  if (typeof window === "undefined") {
    throw new Error("HEIC conversion must run in the browser");
  }

  const heic2any = (await import("heic2any")).default;

  const converted = (await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  })) as Blob;

  return new File([converted], file.name.replace(/\.(heic|heif)$/i, ".jpg"), {
    type: "image/jpeg",
  });
}


function StepCard({ step }: { step: any }) {
  const color =
    step.urgency === "high" ? "#dc2626" : step.urgency === "medium" ? "#f59e0b" : "#6b7280";

  const urgencyLabel =
    step.urgency === "high" ? "High urgency" : step.urgency === "medium" ? "Medium urgency" : "Low urgency";

  

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderLeft: `5px solid ${color}`,
        borderRadius: 12,
        padding: 12,
        background: "#f9fafb",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontWeight: 800 }}>
          {step.step}. {step.title}
        </div>
        <div style={{ color: "#6b7280", fontSize: 12, whiteSpace: "nowrap" }}>{urgencyLabel}</div>
      </div>
      <div style={{ marginTop: 6, color: "#111827" }}>{step.description}</div>
    </div>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Fallback if clipboard blocked
      alert("Copy failed (browser blocked clipboard). You can manually select and copy.");
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div style={{ fontWeight: 800 }}>{label}</div>
        <button
          onClick={copy}
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            padding: "8px 10px",
            background: copied ? "#16a34a" : "white",
            color: copied ? "white" : "#111827",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre
        style={{
          marginTop: 8,
          background: "#f3f4f6",
          border: "1px solid #e5e7eb",
          padding: 12,
          borderRadius: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 13,
          lineHeight: 1.35,
        }}
      >
        {text}
      </pre>
    </div>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 14,
        background: "white",
      }}
    >
      {title ? (
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>{title}</div>
      ) : null}
      {children}
    </div>
  );
}

export default function DoculeaTestPage() {
  const [lang, setLang] = useState<Lang>("en");
  const [text, setText] = useState(
    "FINAL NOTICE: Pay $500 in gift cards or you will be arrested."
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus]=useState<string>("");

  const canAnalyze = useMemo(() => text.trim().length >= 20, [text]);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const r = await fetch("/api/doculea/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentText: text, lang }),
      });

      const raw = await r.text();

      if (!raw) {
        throw new Error(`Empty response body (HTTP ${r.status}). Check Vercel function logs.`);
      }

      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response (HTTP ${r.status}). First 400 chars:\n${raw.slice(0, 400)}`);
      }

      if (!r.ok) {
        throw new Error(json?.error || `Request failed (HTTP ${r.status})`);
      }

      setResult(json);
    } catch (e: any) {
      setError(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }

  }

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [ocrDebug, setOcrDebug] = useState<any>(null);

async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
  // ✅ Guard: this handler should never run on the server, but prevents crashes if bundled oddly
  if (typeof window === "undefined") return;

  const f = e.target.files?.[0] || null;
  if (!f) return;

  const isHeic =
    /heic|heif/i.test(f.type) || /\.heic$|\.heif$/i.test(f.name);

  let finalFile = f;

  if (isHeic) {
    try {
      const mod = await import("heic2any"); // client-only load
      const heic2any = mod.default;

      const blob = (await heic2any({
        blob: f,
        toType: "image/jpeg",
        quality: 0.9,
      })) as Blob;

      finalFile = new File([blob], f.name.replace(/\.(heic|heif)$/i, ".jpg"), {
        type: "image/jpeg",
      });
    } catch {
      setError(
        "This photo is HEIC and couldn’t be converted in this browser. Please retake or switch iPhone Camera Formats to “Most Compatible”."
      );
      return;
    }
  }

  setPhotoFile(finalFile);
  setOcrDebug(null);

  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  setPhotoPreviewUrl(URL.createObjectURL(finalFile));
}

  async function runFromPhoto(file: File, language: "en" | "es") {
  setLoading(true);
  setStatus("Preparing photo...");

  const normalized = await normalizeToJpegIfHeic(file);

  setStatus("Reading text from photo...");
  const text = await ocrInBrowser(normalized, language);

  const q = isOcrTextUsable(text);
  if (!q.ok) {
    setLoading(false);
    setStatus("");
    throw new Error(
      `OCR was too weak (chars=${q.charCount}, words=${q.wordCount}). Retake photo: closer, brighter, avoid glare.`
    );
  }

  setStatus("Analyzing document...");
  const resp = await fetch("/api/doculea/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.trim(), language }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    setLoading(false);
    setStatus("");
    throw new Error(json?.error || `Analyze failed (${resp.status})`);
  }

  setResult(json);
  setLoading(false);
  setStatus("");
}



  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 16px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -0.2 }}>DOCULEA</div>
            <div style={{ color: "#6b7280", marginTop: 6 }}>
              Understand the document. Check legitimacy. Get next steps.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setLang("en")}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: "8px 10px",
                background: lang === "en" ? "#111827" : "white",
                color: lang === "en" ? "white" : "#111827",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              EN
            </button>
            <button
              onClick={() => setLang("es")}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: "8px 10px",
                background: lang === "es" ? "#111827" : "white",
                color: lang === "es" ? "white" : "#111827",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              ES
            </button>
          </div>
        </div>

        

        <div style={{ height: 16 }} />

        

        {/* Input */}
        <Card title="Photo → OCR → Analyze (single image)">
  <input type="file" accept="image/*" capture="environment" onChange={onPickPhoto} />

  {photoPreviewUrl && (
    <div style={{ marginTop: 10 }}>
      <img
        src={photoPreviewUrl}
        style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid #e5e7eb" }}
        alt="preview"
      />
    </div>
  )}

  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
    <button
      onClick={()=>{
        if (!photoFile) return;
        runFromPhoto(photoFile, lang);
      }}
      disabled={!photoFile || loading}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "10px 14px",
        background: !photoFile || loading ? "#e5e7eb" : "#111827",
        color: !photoFile || loading ? "#6b7280" : "white",
        fontWeight: 900,
        cursor: !photoFile || loading ? "not-allowed" : "pointer",
        minWidth: 160,
      }}
    >
      {loading ? "Analyzing…" : "Analyze Photo"}
    </button>
  </div>

  {ocrDebug && (
    <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>
      OCR quality: {ocrDebug.quality?.score} ({ocrDebug.quality?.ok ? "ok" : "retake"})
    </div>
  )}
</Card>

<div style={{ height: 12 }} />

        
        <Card title="Paste a letter / email / message">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            style={{
              width: "100%",
              borderRadius: 12,
              border: "1px solid #e5e7eb",
              padding: 12,
              fontSize: 14,
              lineHeight: 1.35,
              resize: "vertical",
              outline: "none",
            }}
            placeholder="Paste the document text here…"
          />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 12 }}>
            <div style={{ color: "#6b7280", fontSize: 12 }}>
              Min 20 chars. Max is enforced server-side.
            </div>

            <button
              onClick={run}
              disabled={!canAnalyze || loading}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: "10px 14px",
                background: !canAnalyze || loading ? "#e5e7eb" : "#111827",
                color: !canAnalyze || loading ? "#6b7280" : "white",
                fontWeight: 900,
                cursor: !canAnalyze || loading ? "not-allowed" : "pointer",
                minWidth: 140,
              }}
            >
              {loading ? "Analyzing…" : "Analyze"}
            </button>
          </div>

          {error && (
            <div
              style={{
                marginTop: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                padding: 12,
                borderRadius: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              <strong>Error:</strong> {error}
            </div>
          )}
        </Card>

        {/* Results */}
        {result && (
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <StatusBadge status={result.legitimacy_assessment?.status} />

                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  <div>
                    <strong>Type:</strong> {result.document_type?.category} ({result.document_type?.confidence})
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <strong>Confidence:</strong> {result.legitimacy_assessment?.confidence}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 12, color: "#111827" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>Summary</div>
                <div style={{ marginTop: 6 }}>{result.plain_language_summary}</div>
              </div>

              <div style={{ marginTop: 12, color: "#111827" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>What this means for you</div>
                <div style={{ marginTop: 6 }}>{result.what_this_means_for_you}</div>
              </div>

              <div style={{ marginTop: 12, color: "#6b7280", fontSize: 13 }}>
                {result.legitimacy_assessment?.summary_reason}
              </div>
            </Card>

            <Card title="What to do next">
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                {Array.isArray(result.step_by_step_actions) &&
                  result.step_by_step_actions.map((s: any) => <StepCard key={s.step} step={s} />)}
              </div>
            </Card>

            {Array.isArray(result.red_flags) && result.red_flags.length > 0 && (
              <Card title="Red flags">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.red_flags.map((rf: string, idx: number) => (
                    <li key={idx} style={{ marginBottom: 6 }}>
                      {rf}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {(result.suggested_scripts?.call_script || result.suggested_scripts?.email_template) && (
              <Card title="Scripts">
                {result.suggested_scripts?.call_script && (
                  <CopyBlock label="Call script" text={result.suggested_scripts.call_script} />
                )}
                {result.suggested_scripts?.email_template && (
                  <CopyBlock label="Email template" text={result.suggested_scripts.email_template} />
                )}
              </Card>
            )}

            {result.safety_notes && <Card title="Safety notes">{result.safety_notes}</Card>}
          </div>
        )}
      </div>
    </div>
  );
}
