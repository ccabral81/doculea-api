"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ocrInBrowser, isOcrTextUsable, cleanOcrText } from "@/ocr/browserOcr";
import{logEvent, getSessionId} from "@/utils/analytics"

type Lang = "en" | "es";
type Step = "idle" | "preparing" | "ocr" | "analyzing" | "done" | "error";

const STORAGE_LANG_KEY = "doculea_lang";
const STORAGE_SPEAK_KEY = "doculea_speak";

const COPY: Record<Lang, Record<string, string>> = {
  es: {
    tagline: "Entiende el documento. Verifica si es legítimo. Sigue pasos claros.",
    chooseLangTitle: "Elige tu idioma",
    spanish: "Español",
    english: "English",
    languageMenu: "Idioma",
    speakOnboardingTitle: "¿Leer en voz alta?",
    speakOnboardingBody: "Podemos leer el resumen y alertas importantes por ti.",
    speakOn: "Sí, leer",
    speakOff: "No, gracias",
    tipsTitle: "Consejos para una buena foto",
    tips1: "1) Acércate al documento",
    tips2: "2) Buena luz (sin reflejos)",
    tips3: "3) Llena el encuadre",
    takePhoto: "Tomar foto",
    choosePhoto: "Elegir de la galería",
    retake: "Tomar otra",
    preparingPhoto: "Preparando la foto…",
    readingText: "Leyendo el texto…",
    understandingDoc: "Entendiendo el documento…",
    analyzing: "Analizando…",
    weakOcrTitle: "No pudimos leer esto con claridad",
    weakOcrBody: "Intenta de nuevo más cerca y con buena luz. Evita reflejos.",
    tryAgain: "Intentar de nuevo",
    preview: "Ver texto detectado",
    hidePreview: "Ocultar texto detectado",
    pasteTitle: "Pega una carta / email / mensaje",
    pastePlaceholder: "Pega aquí una carta, email o texto del documento para entender qué significa…",
    minChars: "Mínimo 20 caracteres. El máximo se limita en el servidor.",
    analyzeText: "Analizar",
    resultTitle: "Resultado",
    type: "Tipo",
    confidence: "Confianza",
    summary: "Resumen",
    whatItMeans: "Qué significa para ti",
    nextSteps: "Qué hacer ahora",
    redFlags: "Señales de alerta",
    scripts: "Guiones",
    callScript: "Guion para llamada",
    emailTemplate: "Plantilla de email",
    safetyNotes: "Notas de seguridad",
    copy: "Copiar",
    copied: "Copiado",
    copyFail: "No se pudo copiar (el navegador bloqueó el portapapeles). Puedes seleccionar y copiar manualmente.",
    readAloud: "Leer en voz alta",
    stop: "Detener",
    repeat: "Repetir",
    statusLikelyLegit: "Probablemente legítimo",
    statusUnclear: "No está claro",
    statusSuspicious: "Posible estafa detectada",
    urgencyHigh: "Alta urgencia",
    urgencyMedium: "Urgencia media",
    urgencyLow: "Baja urgencia",
    offerIntro: "Esto parece una oferta o promoción. No necesitas inscribirte. Estas cartas a veces usan urgencia para presionarte.",
    legitIntro: "Este documento parece legítimo.",
    unclearIntro: "No está claro si este documento es legítimo. Trátalo con precaución.",
    suspiciousIntro: "Posible estafa detectada. No llames ni hagas clic en enlaces hasta verificarlo.",
    redFlagsSpokenIntro: "Señales de alerta importantes.",
    followStepsSuffix: "Sigue los pasos a continuación para más información."
  },
  en: {
    tagline: "Understand the document. Check legitimacy. Get clear next steps.",
    chooseLangTitle: "Choose your language",
    spanish: "Español",
    english: "English",
    languageMenu: "Language",
    speakOnboardingTitle: "Read aloud?",
    speakOnboardingBody: "We can read the summary and important alerts for you.",
    speakOn: "Yes, read",
    speakOff: "No thanks",
    tipsTitle: "Photo tips",
    tips1: "1) Get close to the document",
    tips2: "2) Bright light (avoid glare)",
    tips3: "3) Fill the frame",
    takePhoto: "Take photo",
    choosePhoto: "Choose from library",
    retake: "Retake",
    preparingPhoto: "Preparing photo…",
    readingText: "Reading text…",
    understandingDoc: "Understanding document…",
    analyzing: "Analyzing…",
    weakOcrTitle: "We couldn’t read this clearly",
    weakOcrBody: "Try again closer with better light. Avoid glare.",
    tryAgain: "Try again",
    preview: "Preview extracted text",
    hidePreview: "Hide extracted text",
    pasteTitle: "Paste a letter / email / message",
    pastePlaceholder: "Paste a letter, email, or document text here to understand what it means…",
    minChars: "Min 20 chars. Max is enforced server-side.",
    analyzeText: "Analyze",
    resultTitle: "Result",
    type: "Type",
    confidence: "Confidence",
    summary: "Summary",
    whatItMeans: "What this means for you",
    nextSteps: "What to do next",
    redFlags: "Red flags",
    scripts: "Scripts",
    callScript: "Call script",
    emailTemplate: "Email template",
    safetyNotes: "Safety notes",
    copy: "Copy",
    copied: "Copied",
    copyFail: "Copy failed (browser blocked clipboard). You can manually select and copy.",
    readAloud: "Read aloud",
    stop: "Stop",
    repeat: "Repeat",
    statusLikelyLegit: "Likely legit",
    statusUnclear: "Unclear",
    statusSuspicious: "Suspicious",
    urgencyHigh: "High urgency",
    urgencyMedium: "Medium urgency",
    urgencyLow: "Low urgency",
    offerIntro: "This appears to be an offer or promotion. You do not need to sign up. These letters often use urgency to pressure you.",
    legitIntro: "This document looks likely legitimate.",
    unclearIntro: "It’s unclear if this document is legitimate. Treat it with caution.",
    suspiciousIntro: "This document looks suspicious. Do not call or click links until you verify it.",
    redFlagsSpokenIntro: "Important red flags.",
    followStepsSuffix: "Follow the steps below for more information."
  },
};

function t(lang: Lang, key: string) {
  return COPY[lang]?.[key] ?? COPY.en[key] ?? key;
}

function uiText(lang: Lang, es: string, en: string) {
  return lang === "es" ? es : en;
}

function getStoredLang(): Lang | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_LANG_KEY);
  return v === "es" || v === "en" ? v : null;
}
function setStoredLang(lang: Lang) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_LANG_KEY, lang);
}

function getStoredSpeak(): boolean | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_SPEAK_KEY);
  if (v === null) return null;
  return v === "1";
}
function setStoredSpeak(on: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_SPEAK_KEY, on ? "1" : "0");
}

function withFollowStepsSuffix(summary: string, lang: Lang) {
  const s = (summary || "").trim();
  if (!s) return "";
  const suffix = t(lang, "followStepsSuffix");
  if (s.toLowerCase().includes(suffix.toLowerCase())) return s;
  return s.endsWith(".") ? `${s} ${suffix}` : `${s}. ${suffix}`;
}

function useIsNarrow(breakpoint = 520) {
  const [isNarrow, setIsNarrow] = React.useState(false);

  React.useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < breakpoint);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);

  return isNarrow;
}


// -----------------------
// 🔊 Voice helpers (prevents “Spanglish” after idle by pinning the correct voice)
// -----------------------
let __doculeaVoiceCache: { es: SpeechSynthesisVoice | null; en: SpeechSynthesisVoice | null } = { es: null, en: null };
let __doculeaVoicesWarm = false;

function ensureVoicesLoaded() {
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;
  try {
    // Calling getVoices() once helps populate voices list in many browsers (esp. iOS/Safari)
    window.speechSynthesis.getVoices?.();
    __doculeaVoicesWarm = true;
  } catch {
    // ignore
  }
}

function pickBestVoice(lang: Lang): SpeechSynthesisVoice | null {
  if (typeof window === "undefined") return null;
  if (!("speechSynthesis" in window)) return null;

  const voices = window.speechSynthesis.getVoices?.() || [];
  if (!voices.length) return null;

  const target = lang === "es" ? "es" : "en";
  const preferredOrder =
    lang === "es"
      ? ["es-MX", "es-US", "es-419", "es-ES", "es"]
      : ["en-US", "en-GB", "en"];

  const byLang = (v: SpeechSynthesisVoice, code: string) => (v.lang || "").toLowerCase().startsWith(code.toLowerCase());

  // 1) Try preferred locale order with localService first
  for (const code of preferredOrder) {
    const v = voices.find((vv) => vv.localService && byLang(vv, code));
    if (v) return v;
  }
  // 2) Any match in preferred order
  for (const code of preferredOrder) {
    const v = voices.find((vv) => byLang(vv, code));
    if (v) return v;
  }
  // 3) Fallback: any voice that starts with target language
  return voices.find((vv) => (vv.lang || "").toLowerCase().startsWith(target)) || null;
}

function getPinnedVoice(lang: Lang): SpeechSynthesisVoice | null {
  ensureVoicesLoaded();

  // Refresh cache each time because browsers can “forget” voices after idle/background.
  const v = pickBestVoice(lang);
  __doculeaVoiceCache[lang] = v;
  return v;
}

function speakQueue(parts: string[], lang: Lang) {
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;

  try {
    // Warm voices list before speaking (helps iOS Safari)
    if (!__doculeaVoicesWarm) ensureVoicesLoaded();

    window.speechSynthesis.cancel();

    const voiceLang = lang === "es" ? "es-MX" : "en-US";
    const voice = getPinnedVoice(lang);

    for (const p of parts) {
      const text = (p || "").trim();
      if (!text) continue;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voiceLang;
      if (voice) u.voice = voice;
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    // ignore
  }
}

function ensureVoiceArmed(lang: Lang): boolean {
  if (typeof window === "undefined") return false;
  if (!("speechSynthesis" in window)) return false;

  try {
    // Must be called from a user gesture on iOS (tap/click)
    ensureVoicesLoaded();
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(lang === "es" ? "Listo" : "Ready");
    u.lang = lang === "es" ? "es-MX" : "en-US";

    const voice = getPinnedVoice(lang);
    if (voice) u.voice = voice;

    // Near-silent “arm” — still counts as a speak() call, avoids being intrusive
    u.volume = 0.01;
    u.rate = 1.0;
    u.pitch = 1.0;

    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

function sanitizeForSpeech(input: string): string {
  return (input || "")
    // bullets/dots
    .replace(/[\u2022\u25CF]/g, "") // • ●
    // smart quotes → normal quotes
    .replace(/[“”]/g, '"')
    // common emoji/symbols that TTS reads literally
    .replace(/[✅✔️☑️🚫⛔⚠️]/g, "")
    // OCR artifacts that get spoken (“plus”)
    .replace(/\+/g, "")
    // normalize whitespace
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function speakNow(text: string, lang: Lang) {
  logEvent("voice_spoken",{lang, parts:3})
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;

  const raw = (text || "").trim();
  if (!raw) return;

  const s = sanitizeForSpeech(raw);
  if (!s) return;

  try {
    if (!__doculeaVoicesWarm) ensureVoicesLoaded();

    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(s);
    u.lang = lang === "es" ? "es-MX" : "en-US";

    const voice = getPinnedVoice(lang);
    if (voice) u.voice = voice;

    u.volume = 1.0;
    u.rate = 1.0;
    u.pitch = 1.0;

    window.speechSynthesis.speak(u);
  } catch {
    // ignore
  }
}

function stopSpeaking() {
  if (typeof window === "undefined") return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

function buildVoiceIntro(result: any, lang: Lang) {
  const actionType = result?.ui_action_type;
  const status = result?.legitimacy_assessment?.status;

  if (actionType === "offer") return "ℹ️ " + t(lang, "offerIntro");
  if (status === "suspicious") return "🚫 " + t(lang, "suspiciousIntro");
  if (status === "unclear") return "⚠️ " + t(lang, "unclearIntro");
  return "✅ " + t(lang, "legitIntro");
}

function buildRedFlagsSpeech(result: any, lang: Lang) {
  if (!Array.isArray(result?.red_flags) || result.red_flags.length === 0) return "";
  const intro = t(lang, "redFlagsSpokenIntro");
  const items = result.red_flags.slice(0, 4);
  const nums = lang === "es" ? ["Uno", "Dos", "Tres", "Cuatro"] : ["One", "Two", "Three", "Four"];
  const list = items.map((rf: string, idx: number) => `${nums[idx] || idx + 1}: ${rf}`).join(". ");
  return `${intro} ${list}`;
}

function StatusBadge({ status, lang }: { status: string; lang: Lang }) {
  const map: Record<string, { bg: string; label: string; dot: string }> = {
    likely_legit: { bg: "#16a34a", label: t(lang, "statusLikelyLegit"), dot: "●" },
    unclear: { bg: "#f59e0b", label: t(lang, "statusUnclear"), dot: "●" },
    suspicious: { bg: "#dc2626", label: t(lang, "statusSuspicious"), dot: "●" },
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

function ProgressBar({ step, lang }: { step: Step; lang: Lang }) {
  const pct =
    step === "preparing" ? 12 : step === "ocr" ? 48 : step === "analyzing" ? 85 : step === "done" ? 100 : 0;

  const label =
    step === "preparing"
      ? t(lang, "preparingPhoto")
      : step === "ocr"
        ? t(lang, "readingText")
        : step === "analyzing"
          ? t(lang, "understandingDoc")
          : "";

  if (step === "idle" || step === "error") return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ color: "#111827", fontWeight: 800, fontSize: 13 }}>{label}</div>
      <div
        style={{
          marginTop: 8,
          height: 10,
          borderRadius: 999,
          background: "#e5e7eb",
          overflow: "hidden",
          border: "1px solid #e5e7eb",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "#111827", borderRadius: 999 }} />
      </div>
    </div>
  );
}

function StepCard({ step, lang }: { step: any; lang: Lang }) {
  const color = step.urgency === "high" ? "#dc2626" : step.urgency === "medium" ? "#f59e0b" : "#6b7280";
  const urgencyLabel =
    step.urgency === "high" ? t(lang, "urgencyHigh") : step.urgency === "medium" ? t(lang, "urgencyMedium") : t(lang, "urgencyLow");

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

function CopyBlock({ label, text, lang }: { label: string; text: string; lang: Lang }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      alert(t(lang, "copyFail"));
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
          {copied ? t(lang, "copied") : t(lang, "copy")}
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
      {title ? <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>{title}</div> : null}
      {children}
    </div>
  );
}

export default function DoculeaTestPage() {
  const [lang, setLang] = useState<Lang>("es");
  const [showLangOnboarding, setShowLangOnboarding] = useState(false);

  const [speakOn, setSpeakOn] = useState(true);

  const [text, setText] = useState("");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("idle");
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [showExtracted, setShowExtracted] = useState(false);

  const [showScripts, setShowScripts] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const lastProgressSpoken = useRef<Step | null>(null);

  const isNarrow = useIsNarrow(520);


  
  useEffect(() => {
    setShowScripts(false);
  }, [result]);
useEffect(() => {
    const stored = getStoredLang();
    if (stored) {
      setLang(stored);
      setShowLangOnboarding(false);
    } else {
      setLang("es");
      setShowLangOnboarding(true);
    }

    const speakStored = getStoredSpeak();
    if (speakStored === null) setSpeakOn(true);
    else setSpeakOn(speakStored);
  }, []);

  useEffect(() => setStoredLang(lang), [lang]);
  useEffect(() => setStoredSpeak(speakOn), [speakOn]);

  useEffect(()=> {logEvent("page_open", {lang})},[]);

  // Narrate progress (only once per step)
  useEffect(() => {
    if (!speakOn) return;
    if (step === "preparing" || step === "ocr" || step === "analyzing") {
      if (lastProgressSpoken.current === step) return;
      lastProgressSpoken.current = step;
      const line =
        step === "preparing"
          ? t(lang, "preparingPhoto")
          : step === "ocr"
            ? t(lang, "readingText")
            : t(lang, "understandingDoc");
      speakQueue([line], lang);
    }
  }, [step, speakOn, lang]);

  const canAnalyze = useMemo(() => text.trim().length >= 20, [text]);
  const loading = step === "preparing" || step === "ocr" || step === "analyzing";

  async function runFromText() {
    setError(null);
    setResult(null);
    setExtractedText(null);
    setStep("analyzing");

    // iOS Safari: ensure speech is unlocked from this tap
    if (speakOn) {
      ensureVoiceArmed(lang);
      speakNow(t(lang, "understandingDoc"), lang);
    }

    try {
      const r = await fetch("/api/doculea/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), language: lang }),
      });

      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || `Request failed (HTTP ${r.status})`);

      setResult(json);
      setStep("done");

      if (speakOn && json?.plain_language_summary) {
        const intro = buildVoiceIntro(json, lang);
        const summary = withFollowStepsSuffix(String(json.plain_language_summary || ""), lang);

        const st = json?.legitimacy_assessment?.status;
        const shouldFlags = st === "suspicious" || st === "unclear";
        const flags = shouldFlags ? buildRedFlagsSpeech(json, lang) : "";

        speakQueue([intro, summary, flags], lang);
      }
    } catch (e: any) {
      setStep("error");
      setError(e?.message || "Unknown error");
    }
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (typeof window === "undefined") return;
    const f = e.target.files?.[0] || null;
    e.currentTarget.value = "";
    if (!f) return;
    logEvent("photo_picked", {lang, fileType: f.type || null});

    // iOS Safari: treat this selection as a user gesture and unlock speech
    if (!speakOn) setSpeakOn(true);
    ensureVoiceArmed(lang);
    speakNow(t(lang, "readingText"), lang);

    setError(null);
    setResult(null);
    setExtractedText(null);

    let finalFile = f;
    try {
      finalFile = await normalizeToJpegIfHeic(f);
    } catch {
      setStep("error");
      setError(
        lang === "es"
          ? "Esta foto es HEIC y no se pudo convertir en este navegador. Por favor toma otra foto o cambia el iPhone a 'Más compatible'."
          : "This photo is HEIC and couldn’t be converted in this browser. Please retake or switch iPhone Camera Formats to 'Most Compatible'."
      );
      return;
    }

    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    setPhotoPreviewUrl(URL.createObjectURL(finalFile));

    try {
      await runFromPhoto(finalFile, lang);
    } catch (err: any) {
      setStep("error");
      setError(err?.message || "Unknown error");
    }
  }

  async function runFromPhoto(file: File, language: Lang) {
    setError(null);
    setResult(null);
    setExtractedText(null);

    setStep("preparing");
    const normalized = await normalizeToJpegIfHeic(file);

    setStep("ocr");
    logEvent("ocr_start", {lang});
    const ocrText = await ocrInBrowser(normalized, language);
    setExtractedText(ocrText);
    const q: any = isOcrTextUsable(ocrText, language);
    if (q?.level === "fail" || q?.ok === false) {
     
      setStep("error");
      logEvent("ocr_fail_quality", {lang, ocr: {chars:q.charCount, words:q.wordCount, phrases: q.phraseCount, lines: q.lineCount},
            });
      const msg =
        language === "es"
          ? `${t(language, "weakOcrTitle")} (caracteres=${q.charCount}, palabras=${q.wordCount}, frases=${q.phraseCount}, líneas=${q.lineCount}).\n\n${t(language, "weakOcrBody")}`
          : `${t(language, "weakOcrTitle")} (chars=${q.charCount}, words=${q.wordCount}, phrases=${q.phraseCount}, lines=${q.lineCount}).\n\n${t(language, "weakOcrBody")}`;
      throw new Error(msg);
    }
    logEvent("ocr_ok", {lang, ocr: {chars:q.charCount, words:q.wordCount, phrases: q.phraseCount, lines: q.lineCount},
      });
    // send cleaned text for better signal
    const cleaned = cleanOcrText ? cleanOcrText(ocrText).trim() : ocrText.trim();     

    setStep("analyzing");
    logEvent("analyze_start", {lang, source: "photo"});
    const resp = await fetch("/api/doculea/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cleaned, language }),
    }
  );
   
    const json = await resp.json();
    if (!resp.ok) {
    logEvent("analyze_fail", {
      lang,
      source: "photo",
      error: String(json?.error || `Analyze failed (${resp.status})`)
    });  
    throw new Error(json?.error || `Analyze failed (${resp.status})`);
    }

    setResult(json);
      logEvent("analyze_success", {
      lang,
      source: "photo",
    docType: json?.document_type?.category ?? null,
    status: json?.legitimacy_assessment?.status ?? null,
    confidence: json?.legitimacy_assessment?.confidence ?? null,
    });  
    setStep("done");

    if (speakOn && json?.plain_language_summary) {
      const intro = buildVoiceIntro(json, language);
      const summary = withFollowStepsSuffix(String(json.plain_language_summary || ""), language);

      const st = json?.legitimacy_assessment?.status;
      const shouldFlags = st === "suspicious" || st === "unclear";
      const flags = shouldFlags ? buildRedFlagsSpeech(json, language) : "";

      speakQueue([intro, summary, flags], language);
    }
  }

  const pickCamera = () => {
    if (!speakOn) setSpeakOn(true);
    ensureVoiceArmed(lang);
    cameraInputRef.current?.click();
  };
  const pickLibrary = () => {
    if (!speakOn) setSpeakOn(true);
    ensureVoiceArmed(lang);
    libraryInputRef.current?.click();
  };
  const setLanguage = (l: Lang) => {
    setLang(l);
    setStoredLang(l);
    setShowLangOnboarding(false);
  };

  const repeatSpeaking = () => {
    if (!result?.plain_language_summary) return;
    const intro = buildVoiceIntro(result, lang);
    const summary = withFollowStepsSuffix(String(result.plain_language_summary || ""), lang);
    const st = result?.legitimacy_assessment?.status;
    const flags = st === "suspicious" || st === "unclear" ? buildRedFlagsSpeech(result, lang) : "";
    speakQueue([intro, summary, flags], lang);
  };

  const hideScripts =
    result?.ui_action_type === "offer" ||
    result?.legitimacy_assessment?.status === "suspicious" ||
    result?.legitimacy_assessment?.status === "unclear";

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 16px" }}>
        {showLangOnboarding && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 50,
            }}
          >
            <div style={{ width: "100%", maxWidth: 420, background: "white", borderRadius: 16, padding: 16, border: "1px solid #e5e7eb" }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>{t("es", "chooseLangTitle")}</div>
              <div style={{ color: "#6b7280", marginTop: 6 }}>
                {"Selecciona Español o English para continuar."}
              </div>

              <div style={{ marginTop: 12, border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f9fafb" }}>
                <div style={{ fontWeight: 900 }}>{t("es", "speakOnboardingTitle")}</div>
                <div style={{ color: "#6b7280", marginTop: 6 }}>{t("es", "speakOnboardingBody")}</div>
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button
                    onClick={() => {
                      setSpeakOn(true);
                      setStoredSpeak(true);
                    }}
                    style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", background: "#111827", color: "white", fontWeight: 900, cursor: "pointer" }}
                  >
                    {t("es", "speakOn")}
                  </button>
                  <button
                    onClick={() => {
                      setSpeakOn(false);
                      setStoredSpeak(false);
                    }}
                    style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", background: "white", color: "#111827", fontWeight: 900, cursor: "pointer" }}
                  >
                    {t("es", "speakOff")}
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 14 }}>
                <button
                  onClick={() => {
                    setLanguage("es");
                    if (speakOn) speakQueue(["Español seleccionado."], "es");
                  }}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: "12px 14px",
                    background: "#111827",
                    color: "white",
                    fontWeight: 900,
                    cursor: "pointer",
                    fontSize: 16,
                  }}
                >
                  {t("es", "spanish")}
                </button>
                <button
                  onClick={() => {
                    setLanguage("en");
                    if (speakOn) speakQueue(["English selected."], "en");
                  }}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: "12px 14px",
                    background: "white",
                    color: "#111827",
                    fontWeight: 900,
                    cursor: "pointer",
                    fontSize: 16,
                  }}
                >
                  {t("en", "english")}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -0.2 }}>DOCU-LEA</div>
            <div style={{ color: "#6b7280", marginTop: 6 }}>{t(lang, "tagline")}</div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ color: "#6b7280", fontSize: 12, fontWeight: 800 }}>{t(lang, "languageMenu")}</div>

            <button
              onClick={() => setLanguage("es")}
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
              {t(lang, "spanish")}
            </button>

            <button
              onClick={() => setLanguage("en")}
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
              {t(lang, "english")}
            </button>
          </div>
        </div>


        <div style={{ height: 16 }} />
<Card>
  <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>
    Docu-Lea
  </div>
  <div style={{ fontWeight: 800, color: "#374151", marginBottom: 10 }}>
    Document Legitimacy Assistant
  </div>

  <div style={{ color: "#111827", lineHeight: 1.5 }}>
    {lang === "es" ? (
      <>
        Docu-Lea te ayuda a entender cartas, avisos, facturas y emails que pueden ser
        confusos, urgentes o sospechosos.
        <br /><br />
        Toma una foto, sube un archivo o pega el texto, y Docu-Lea te explicará qué es,
        si parece legítimo y qué (si es necesario) debes hacer.
      </>
    ) : (
      <>
        Docu-Lea helps you understand letters, notices, bills, and emails that may be
        confusing, urgent, or suspicious.
        <br /><br />
        Take a photo, upload a file, or paste text, and Docu-Lea will explain what it is,
        whether it looks legitimate, and what (if anything) you should do next.
      </>
    )}
  </div>

  <div style={{ marginTop: 10, fontSize: 13, color: "#6b7280" }}>
    {lang === "es"
      ? "Los documentos se analizan al instante y no se guardan."
      : "Documents are analyzed instantly and are not stored."}
  </div>
</Card>


        <div style={{ height: 12 }} />

        <div style={{ height: 16 }} />

        <Card title={`${t(lang, "tipsTitle")}`}>
          <div style={{ color: "#111827", fontWeight: 700, lineHeight: 1.4 }}>
            <div>{t(lang, "tips1")}</div>
            <div>{t(lang, "tips2")}</div>
            <div>{t(lang, "tips3")}</div>
          </div>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPickPhoto}
            style={{ display: "none" }}
          />
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            onChange={onPickPhoto}
            style={{ display: "none" }}
          />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            <button
              onClick={pickCamera}
              disabled={loading}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: "12px 14px",
                background: loading ? "#e5e7eb" : "#111827",
                color: loading ? "#6b7280" : "white",
                fontWeight: 900,
                cursor: loading ? "not-allowed" : "pointer",
                minWidth: 170,
              }}
            >
              {t(lang, "takePhoto")}
            </button>

            <button
              onClick={pickLibrary}
              disabled={loading}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: "12px 14px",
                background: "white",
                color: "#111827",
                fontWeight: 900,
                cursor: loading ? "not-allowed" : "pointer",
                minWidth: 170,
                opacity: loading ? 0.6 : 1,
              }}
            >
              {t(lang, "choosePhoto")}
            </button>
          </div>

          {photoPreviewUrl && (
            <div style={{ marginTop: 12 }}>
              <img
                src={photoPreviewUrl}
                style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid #e5e7eb" }}
                alt="preview"
              />
            </div>
          )}

          <ProgressBar step={step} lang={lang} />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 800, color: "#111827" }}>
              <input
                type="checkbox"
                checked={speakOn}
                onChange={(e) => setSpeakOn(e.target.checked)}
                disabled={loading}
              />
              {t(lang, "readAloud")}
            </label>

            <button
              onClick={stopSpeaking}
              disabled={loading}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: "8px 10px",
                background: "white",
                color: "#111827",
                fontWeight: 800,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {t(lang, "stop")}
            </button>

            <button
              onClick={repeatSpeaking}
              disabled={!result?.plain_language_summary}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: "8px 10px",
                background: !result?.plain_language_summary ? "#e5e7eb" : "white",
                color: !result?.plain_language_summary ? "#6b7280" : "#111827",
                fontWeight: 800,
                cursor: !result?.plain_language_summary ? "not-allowed" : "pointer",
              }}
            >
              {t(lang, "repeat")}
            </button>
          </div>

          {extractedText && (
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => setShowExtracted((v) => !v)}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "8px 10px",
                  background: "white",
                  color: "#111827",
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {showExtracted ? t(lang, "hidePreview") : t(lang, "preview")}
              </button>

              {showExtracted && (
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
                  {extractedText}
                </pre>
              )}
            </div>
          )}

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
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={() => {
                    setError(null);
                    setStep("idle");
                    setResult(null);
                    setExtractedText(null);
                    lastProgressSpoken.current = null;
                  }}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: "10px 14px",
                    background: "#111827",
                    color: "white",
                    fontWeight: 900,
                    cursor: "pointer",
                  }}
                >
                  {t(lang, "tryAgain")}
                </button>
              </div>
            </div>
          )}
        </Card>

        <div style={{ height: 12 }} />

        <Card title={t(lang, "pasteTitle")}>
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
            placeholder={t(lang, "pastePlaceholder")}
          />

      <div
  style={{
    display: "flex",
    flexDirection: isNarrow ? "column" : "row",
    alignItems: isNarrow ? "stretch" : "center",
    marginTop: 10,
    gap: 12,
  }}
>
  <div style={{ color: "#6b7280", fontSize: 12 }}>
    {t(lang, "minChars")}
  </div>

  <button
    onClick={runFromText}
    disabled={!canAnalyze || loading}
    style={{
      width: isNarrow ? "100%" : undefined,
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: "10px 14px",
      background: !canAnalyze || loading ? "#e5e7eb" : "#111827",
      color: !canAnalyze || loading ? "#6b7280" : "white",
      fontWeight: 900,
      cursor: !canAnalyze || loading ? "not-allowed" : "pointer",
      minWidth: isNarrow ? undefined : 140,
    }}
  >
    {loading ? t(lang, "analyzing") : t(lang, "analyzeText")}
  </button>
</div>

        </Card>

        {result && (
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <StatusBadge status={result.legitimacy_assessment?.status} lang={lang} />

                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  <div>
                    <strong>{t(lang, "type")}:</strong> {result.document_type?.category} ({result.document_type?.confidence})
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <strong>{t(lang, "confidence")}:</strong> {result.legitimacy_assessment?.confidence}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 12, color: "#111827" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{t(lang, "summary")}</div>
                <div style={{ marginTop: 6 }}>{withFollowStepsSuffix(String(result.plain_language_summary || ""), lang)}</div>
              </div>

              <div style={{ marginTop: 12, color: "#111827" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{t(lang, "whatItMeans")}</div>
                <div style={{ marginTop: 6 }}>{result.what_this_means_for_you}</div>
              </div>

              <div style={{ marginTop: 12, color: "#6b7280", fontSize: 13 }}>{result.legitimacy_assessment?.summary_reason}</div>
            </Card>

            <Card title={t(lang, "nextSteps")}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                {Array.isArray(result.step_by_step_actions) &&
                  result.step_by_step_actions.map((s: any) => <StepCard key={s.step} step={s} lang={lang} />)}
              </div>
            </Card>

            {Array.isArray(result.red_flags) && result.red_flags.length > 0 && (
              <Card title={t(lang, "redFlags")}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.red_flags.map((rf: string, idx: number) => (
                    <li key={idx} style={{ marginBottom: 6 }}>
                      {rf}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {!hideScripts &&
              (result.suggested_scripts?.call_script || result.suggested_scripts?.email_template) && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{t(lang, "scripts")}</div>
                    <button
                      onClick={() => setShowScripts((v) => !v)}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 10,
                        padding: "8px 10px",
                        background: "white",
                        cursor: "pointer",
                        fontWeight: 800,
                      }}
                    >
                      {showScripts ? (lang === "es" ? "Ocultar" : "Hide") : (lang === "es" ? "Ver guion completo" : "Show full script")}
                    </button>
                  </div>

                  {!showScripts && (
                    <div style={{ marginTop: 10, color: "#374151", fontSize: 14 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>{lang === "es" ? "Vista previa:" : "Preview:"}</div>

                      {result.suggested_scripts?.call_script && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontWeight: 800, marginBottom: 4 }}>{t(lang, "callScript")}</div>
                          <div style={{ whiteSpace: "pre-wrap" }}>
                            {String(result.suggested_scripts.call_script).trim().slice(0, 180)}
                            {String(result.suggested_scripts.call_script).trim().length > 180 ? "…" : ""}
                          </div>
                        </div>
                      )}

                      {result.suggested_scripts?.email_template && (
                        <div style={{ marginBottom: 0 }}>
                          <div style={{ fontWeight: 800, marginBottom: 4 }}>{t(lang, "emailTemplate")}</div>
                          <div style={{ whiteSpace: "pre-wrap" }}>
                            {String(result.suggested_scripts.email_template).trim().slice(0, 180)}
                            {String(result.suggested_scripts.email_template).trim().length > 180 ? "…" : ""}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {showScripts && (
                    <div style={{ marginTop: 10 }}>
                      {result.suggested_scripts?.call_script && (
                        <CopyBlock label={t(lang, "callScript")} text={result.suggested_scripts.call_script} lang={lang} />
                      )}
                      {result.suggested_scripts?.email_template && (
                        <CopyBlock label={t(lang, "emailTemplate")} text={result.suggested_scripts.email_template} lang={lang} />
                      )}
                    </div>
                  )}
                </Card>
              )}

            {result.safety_notes && <Card title={t(lang, "safetyNotes")}>{result.safety_notes}</Card>}




      {isNarrow && canAnalyze && !loading && (
  <div
    style={{
      position: "sticky",
      bottom: 0,
      zIndex: 20,
      background: "rgba(255,255,255,0.92)",
      backdropFilter: "blur(6px)",
      borderTop: "1px solid #e5e7eb",
      padding: 12,
      marginTop: 12,
    }}
  >
    <button
      onClick={runFromText}
      style={{
        width: "100%",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "12px 14px",
        background: "#111827",
        color: "white",
        fontWeight: 900,
        cursor: "pointer",
      }}
    >
      {t(lang, "analyzeText")}
    </button>
  </div>
)}





          </div>

        )}

  {/* Disclaimer + Footer */}
        <div style={{ marginTop: 20, fontSize: 12, color: "#6b7280", lineHeight: 1.4 }}>
          {uiText(
            lang,
            "Al usar Docu-Lea, aceptas que la información es solo educativa y no constituye asesoría legal o financiera.",
            "By using Docu-Lea, you acknowledge the information is for educational purposes only and is not legal or financial advice."
          )}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280", lineHeight: 1.4 }}>
          {uiText(
            lang,
            "Al continuar, aceptas nuestros Términos y Condiciones.",
            "By continuing, you agree to our Terms & Conditions."
          )}
        </div>

        <div
          style={{
            marginTop: 18,
            paddingTop: 12,
            borderTop: "1px solid #e5e7eb",
            fontSize: 12,
            color: "#6b7280",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>Docu-Lea</div>
          <div>Author: Carlos E. Cabral</div>
        </div>

      </div>
    </div>
  );

  
}

