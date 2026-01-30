"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

// If you already have your own OCR util, import it instead:
// import { runBrowserOcr } from "../lib/browserOcr";
type Lang = "es" | "en";

type Step = "idle" | "preparing" | "ocr" | "analyzing" | "done" | "error";

const COPY: Record<Lang, Record<string, string>> = {
  es: {
    chooseLangTitle: "Elige tu idioma",
    spanish: "Español",
    english: "English",
    languageMenu: "Idioma",
    tips: "1) Acércate  2) Buena luz  3) Evita reflejos",
    takePhoto: "Tomar foto",
    choosePhoto: "Elegir de la galería",
    preparingPhoto: "Preparando la foto…",
    readingText: "Leyendo el texto…",
    understandingDoc: "Entendiendo el documento…",
    weakOcrTitle: "No pudimos leer esto con claridad",
    weakOcrBody: "Intenta de nuevo más cerca y con buena luz. Evita reflejos.",
    tryAgain: "Intentar de nuevo",
    readAloud: "Leer en voz alta",
    stop: "Detener",
    repeat: "Repetir",
    previewText: "Ver texto detectado",
    hidePreview: "Ocultar texto detectado",
    resultTitle: "Resultado",
    summary: "Resumen",
    whatItMeans: "Qué significa",
    nextSteps: "Qué hacer ahora",
    scripts: "Guiones",
    safetyNotes: "Notas de seguridad",
  },
  en: {
    chooseLangTitle: "Choose your language",
    spanish: "Español",
    english: "English",
    languageMenu: "Language",
    tips: "1) Get close  2) Good light  3) Avoid glare",
    takePhoto: "Take photo",
    choosePhoto: "Choose from library",
    preparingPhoto: "Preparing photo…",
    readingText: "Reading text…",
    understandingDoc: "Understanding document…",
    weakOcrTitle: "We couldn’t read this clearly",
    weakOcrBody: "Try again closer with better light. Avoid glare.",
    tryAgain: "Try again",
    readAloud: "Read aloud",
    stop: "Stop",
    repeat: "Repeat",
    previewText: "Preview extracted text",
    hidePreview: "Hide extracted text",
    resultTitle: "Result",
    summary: "Summary",
    whatItMeans: "What it means",
    nextSteps: "What to do next",
    scripts: "Scripts",
    safetyNotes: "Safety notes",
  },
};

function t(lang: Lang, key: string) {
  return COPY[lang][key] ?? COPY.en[key] ?? key;
}

function normalizeLang(input: any): Lang {
  // Defensive: prevents sending "Español"/"English" to API
  if (input === "Español") return "es";
  if (input === "English") return "en";
  return input === "en" ? "en" : "es";
}

function speak(text: string, lang: Lang) {
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "es" ? "es-US" : "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

function stopSpeak() {
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

// --- Replace this with your existing browser OCR function ---
async function runBrowserOcrMock(_file: File, _lang: Lang): Promise<string> {
  // TODO: swap with your real OCR call:
  // return await runBrowserOcr(file, lang)
  throw new Error(
    "OCR function not wired. Replace runBrowserOcrMock() with your real browser OCR function import."
  );
}
// ------------------------------------------------------------

export default function DoculeaTestPage() {
  const [lang, setLang] = useState<Lang>("es");
  const [showLangModal, setShowLangModal] = useState(false);

  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string>("");
  const [showOcrPreview, setShowOcrPreview] = useState(false);

  const [result, setResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const [readAloudEnabled, setReadAloudEnabled] = useState(true);
  const lastSummaryRef = useRef<string>("");

  const lastFileRef = useRef<File | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("doculea_lang");
    const normalized = normalizeLang(stored);
    setLang(normalized);

    // first-time onboarding
    if (!stored) setShowLangModal(true);
  }, []);

  function saveLang(newLang: Lang) {
    const normalized = normalizeLang(newLang);
    setLang(normalized);
    localStorage.setItem("doculea_lang", normalized);
  }

  function setStepWithProgress(next: Step) {
    setStep(next);
    if (next === "preparing") setProgress(10);
    if (next === "ocr") setProgress(45);
    if (next === "analyzing") setProgress(85);
    if (next === "done") setProgress(100);
    if (next === "error") setProgress(0);
  }

  function rememberFile(file: File) {
    lastFileRef.current = file;
  }

  function clearInputs() {
    // So selecting same file again triggers onChange
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (libraryInputRef.current) libraryInputRef.current.value = "";
  }

  function setImagePreview(file: File) {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
  }

  function ocrQualityGate(text: string) {
    const cleaned = text.replace(/\s+/g, " ").trim();
    const charCount = cleaned.length;
    const wordCount = cleaned.split(" ").filter(Boolean).length;

    // Tune thresholds as needed
    const MIN_CHARS = 120;
    const MIN_WORDS = 25;

    return { ok: charCount >= MIN_CHARS && wordCount >= MIN_WORDS, charCount, wordCount };
  }

  async function startPipeline(file: File) {
    const langNormalized = normalizeLang(lang);

    setErrorMsg("");
    setResult(null);
    lastSummaryRef.current = "";

    rememberFile(file);
    clearInputs();
    setImagePreview(file);

    try {
      setStepWithProgress("preparing");

      // 1) OCR
      setStepWithProgress("ocr");
      // IMPORTANT: swap mock with your real OCR function
      const text = await runBrowserOcrMock(file, langNormalized);
      setOcrText(text);

      const q = ocrQualityGate(text);
      if (!q.ok) {
        setErrorMsg(`${t(langNormalized, "weakOcrTitle")}\n${t(langNormalized, "weakOcrBody")}`);
        setStepWithProgress("error");
        return;
      }

      // 2) Analyze
      setStepWithProgress("analyzing");

      const res = await fetch("/api/doculea/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language: langNormalized, // MUST be "es" | "en"
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        console.error("Analyze HTTP error:", res.status, data);
        throw new Error(data?.error || data?.message || `Analyze failed (${res.status})`);
      }

      // If your API wraps errors as ok:false
      if (data?.ok === false) {
        console.error("Analyze returned ok:false:", data);
        throw new Error(data?.error || "AI failed validation");
      }

      setResult(data);
      setStepWithProgress("done");

      // Speak summary (best-effort)
      const summary =
        data?.plain_summary ||
        data?.plain_language_summary ||
        data?.summary ||
        "";
      if (summary) {
        lastSummaryRef.current = summary;
        if (readAloudEnabled) speak(summary, langNormalized);
      }
    } catch (err: any) {
      console.error("Pipeline error:", err);
      setErrorMsg(err?.message || "Unknown error");
      setStepWithProgress("error");
    }
  }

  async function onFileChosen(file: File) {
    await startPipeline(file);
  }

  async function retrySameFile() {
    const f = lastFileRef.current;
    if (!f) return;
    await startPipeline(f);
  }

  const statusLabel = useMemo(() => {
    const L = normalizeLang(lang);
    if (step === "preparing") return t(L, "preparingPhoto");
    if (step === "ocr") return t(L, "readingText");
    if (step === "analyzing") return t(L, "understandingDoc");
    if (step === "done") return "✓";
    return "";
  }, [step, lang]);

  const L = normalizeLang(lang);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      {/* Language modal */}
      {showLangModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50
        }}>
          <div style={{ background: "white", borderRadius: 12, padding: 16, width: "100%", maxWidth: 420 }}>
            <h2 style={{ marginTop: 0 }}>{t(L, "chooseLangTitle")}</h2>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                style={{ flex: 1, padding: 12, fontSize: 16 }}
                onClick={() => { saveLang("es"); setShowLangModal(false); }}
              >
                {t("es", "spanish")}
              </button>
              <button
                style={{ flex: 1, padding: 12, fontSize: 16 }}
                onClick={() => { saveLang("en"); setShowLangModal(false); }}
              >
                {t("en", "english")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0 }}>DOCU-LEA</h1>
        <div>
          <label style={{ marginRight: 8, fontSize: 14 }}>{t(L, "languageMenu")}:</label>
          <select
            value={L}
            onChange={(e) => saveLang(e.target.value as Lang)}
            style={{ padding: 8 }}
          >
            <option value="es">{t("es", "spanish")}</option>
            <option value="en">{t("en", "english")}</option>
          </select>
        </div>
      </div>

      <p style={{ marginTop: 8, opacity: 0.8 }}>{t(L, "tips")}</p>

      {/* Upload buttons */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <label style={{ display: "inline-block" }}>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFileChosen(f);
            }}
          />
          <button style={{ padding: 12, fontSize: 16 }}>{t(L, "takePhoto")}</button>
        </label>

        <label style={{ display: "inline-block" }}>
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFileChosen(f);
            }}
          />
          <button style={{ padding: 12, fontSize: 16 }}>{t(L, "choosePhoto")}</button>
        </label>
      </div>

      {/* Preview */}
      {imageUrl && (
        <div style={{ marginTop: 16 }}>
          <img src={imageUrl} alt="preview" style={{ maxWidth: "100%", borderRadius: 8 }} />
        </div>
      )}

      {/* Progress */}
      {(step === "preparing" || step === "ocr" || step === "analyzing") && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8 }}>{statusLabel}</div>
          <div style={{ height: 10, background: "#eee", borderRadius: 999 }}>
            <div style={{ height: 10, width: `${progress}%`, background: "#222", borderRadius: 999 }} />
          </div>
        </div>
      )}

      {/* Error */}
      {step === "error" && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>{errorMsg}</div>
          <button style={{ padding: 12, fontSize: 16 }} onClick={() => void retrySameFile()}>
            {t(L, "tryAgain")}
          </button>
        </div>
      )}

      {/* OCR preview toggle */}
      {ocrText && (
        <div style={{ marginTop: 16 }}>
          <button
            style={{ padding: 8, fontSize: 14 }}
            onClick={() => setShowOcrPreview((v) => !v)}
          >
            {showOcrPreview ? t(L, "hidePreview") : t(L, "previewText")}
          </button>

          {showOcrPreview && (
            <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 8 }}>
              {ocrText}
            </pre>
          )}
        </div>
      )}

      {/* Result */}
      {step === "done" && result && (
        <div style={{ marginTop: 20 }}>
          <h2>{t(L, "resultTitle")}</h2>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={readAloudEnabled}
                onChange={(e) => setReadAloudEnabled(e.target.checked)}
              />
              {t(L, "readAloud")}
            </label>

            <button style={{ padding: 8 }} onClick={() => stopSpeak()}>
              {t(L, "stop")}
            </button>
            <button
              style={{ padding: 8 }}
              onClick={() => {
                if (lastSummaryRef.current) speak(lastSummaryRef.current, L);
              }}
            >
              {t(L, "repeat")}
            </button>
          </div>

          <section style={{ marginBottom: 16 }}>
            <h3>{t(L, "summary")}</h3>
            <p>
              {result?.plain_summary ||
                result?.plain_language_summary ||
                result?.summary ||
                ""}
            </p>
          </section>

          <section style={{ marginBottom: 16 }}>
            <h3>{t(L, "whatItMeans")}</h3>
            <p>{result?.what_it_means || result?.meaning || ""}</p>
          </section>

          <section style={{ marginBottom: 16 }}>
            <h3>{t(L, "nextSteps")}</h3>
            <ol>
              {(result?.next_steps || result?.step_by_step_actions || []).map((s: any, i: number) => (
                <li key={i}>{typeof s === "string" ? s : s?.text || JSON.stringify(s)}</li>
              ))}
            </ol>
          </section>

          <section style={{ marginBottom: 16 }}>
            <h3>{t(L, "scripts")}</h3>
            <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 8 }}>
              {result?.scripts ? JSON.stringify(result.scripts, null, 2) : ""}
            </pre>
          </section>

          <section style={{ marginBottom: 16 }}>
            <h3>{t(L, "safetyNotes")}</h3>
            <ul>
              {(result?.safety_notes || result?.safety || []).map((s: any, i: number) => (
                <li key={i}>{typeof s === "string" ? s : s?.text || JSON.stringify(s)}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
