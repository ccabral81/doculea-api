import type { DoculeaResponse } from "../schema/doculeaSchema";

/**
 * Detects strong scam indicators in raw text.
 * This does NOT modify output by itself.
 */
export function hasHardScamSignals(text: string): boolean {
  const t = (text || "").toLowerCase();
  const patterns = [
    "gift card",
    "giftcard",
    "crypto",
    "bitcoin",
    "wire transfer",
    "western union",
    "moneygram",
    "arrest",
    "warrant",
    "police",
    "ssn",
    "social security",
    "verification code",
    "one-time code",
    "otp",
  ];
  return patterns.some((p) => t.includes(p));
}

/**
 * V2: Detects strong scam indicators in raw text (especially link-based “pay now” scams
 * that impersonate government/companies and use urgency + non-official domains).
 *
 * IMPORTANT:
 * - This does NOT modify output by itself.
 * - We keep legacy signals from hasHardScamSignals(), and add extra checks.
 */
function extractUrls(text: string): string[] {
  const t = text || "";
  const urls = t.match(/https?:\/\/[^ -\s)]+/gi) ?? [];
  return urls.map((u) => u.replace(/[),.;]+$/g, ""));
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOfficialNJDomain(host: string): boolean {
  // NJ government sites are typically *.nj.gov (and nj.gov).
  return host === "nj.gov" || host.endsWith(".nj.gov");
}

function looksLikeGovButNotGov(host: string): boolean {
  // e.g., "nj.govnxt.help" contains ".gov" but is NOT a .gov / .nj.gov domain.
  return host.includes(".gov") && !host.endsWith(".gov") && !host.endsWith(".nj.gov");
}

function hasStrongPressureThreatLanguage(t: string): boolean {
  const patterns = [
    "final notice",
    "last notice",
    "payment required",
    "pay now",
    "avoid penalties",
    "enforcement action",
    "legal proceedings",
    "credit reporting",
    "registration suspended",
    "suspended",
    "suspension",
  ];
  return patterns.some((p) => t.includes(p));
}

// (Opcional) si quieres conservar algo “suave” para otras reglas:
function hasMildBillingLanguage(t: string): boolean {
  const patterns = ["due date", "deadline", "additional fee", "late fee", "past due"];
  return patterns.some((p) => t.includes(p));
}

function hasGovImpersonationSignals(t: string): boolean {
  const patterns = [
    "njmvc",
    "motor vehicle",
    "new jersey",
    "n.j.s.a",
    "title 39",
    "department of motor vehicles",
    "dmv",
  ];
  return patterns.some((p) => t.includes(p));
}

function missingCaseIdentifiers(t: string): boolean {
  const claimsTraffic =
    t.includes("traffic") || t.includes("violation") || t.includes("ticket") || t.includes("summons");
  if (!claimsTraffic) return false;

  const hasIdentifiers =
    t.includes("ticket #") ||
    t.includes("ticket number") ||
    t.includes("summons #") ||
    t.includes("summons number") ||
    t.includes("case #") ||
    t.includes("case number") ||
    t.includes("municipal court") ||
    t.includes("court") ||
    t.includes("plate") ||
    t.includes("license plate");

  return !hasIdentifiers;
}

function looksLikeUtilityBill(t: string): boolean {
  const s = (t || "").toLowerCase();
  const signals = [ "amount due",
    "total due",
    "balance due",
    "due date",
    "billing period",
    "statement date",
    "account number",
    "service address",
    "meter",
    "usage",
    "previous balance",
    "current charges",
    "payment received",
    "remit",
    "remittance",
    "payment stub",
    "water",
    "sewer",
    "utility bill",
    // Spanish
    "monto a pagar",
    "total a pagar",
    "saldo",
    "fecha de vencimiento",
    "periodo de facturacion",
    "fecha de estado",
    "numero de cuenta",
    "direccion de servicio",
    "medidor",
    "consumo",
    "saldo anterior",
    "cargos actuales",
    "pago recibido",
    "comprobante de pago",
    "agua",
    "alcantarillado",
    "factura",
  ];
  return signals.filter(x => s.includes(x)).length >= 2;
}


export function hasHardScamSignalsV2(text: string): boolean {
  const raw = text || "";
  const t = raw.toLowerCase();

  if (looksLikeUtilityBill(raw) && extractUrls(raw).length > 0) {
  // Facturas reales suelen tener link de pago; no lo uses como hard-scam por sí solo
  // (Solo se marcará scam si hay gift card/crypto, etc.)
  // OJO: deja que legacy hard signals sigan funcionando
}


  // 1) Keep the legacy “hard stop” signals.
  if (hasHardScamSignals(raw)) return true;

  // 2) Link-based impersonation + urgency patterns (like the NJ traffic scam example).
  const urls = extractUrls(raw);
  const hosts = urls.map(getHostname).filter(Boolean) as string[];

  const hasAnyUrl = urls.length > 0;
  const strongpressure = hasStrongPressureThreatLanguage(t);
  const govSignals = hasGovImpersonationSignals(t);

  const hasGovLookalikeDomain = hosts.some(looksLikeGovButNotGov);

  const mentionsPaymentPortal = t.includes("portal") || t.includes("pay") || t.includes("payment");
  const hasNJClaimButNoOfficialDomain =
    govSignals && hasAnyUrl && hosts.length > 0 && !hosts.some(isOfficialNJDomain);

  const hasPaymentLinkOnNonOfficialDomain =
    mentionsPaymentPortal &&
    hasAnyUrl &&
    hosts.length > 0 &&
    !hosts.some((h) => h.endsWith(".gov") || h.endsWith(".nj.gov"));

  const missingIds = missingCaseIdentifiers(t);

  // Trigger if we see strong combo patterns (aiming to minimize false positives).
  if (hasGovLookalikeDomain) return true;
  if (hasNJClaimButNoOfficialDomain && (strongpressure || mentionsPaymentPortal)) return true;
  if (hasPaymentLinkOnNonOfficialDomain && (strongpressure || govSignals)) return true;
  if (!hasAnyUrl && strongpressure && govSignals && missingIds && mentionsPaymentPortal) return true;

  return false;
}

/**
 * Enforces hard safety overrides on an already-valid AI result.
 * MUST ALWAYS return a DoculeaResponse.
 * DOES NOT change AI logic, only applies safety guardrails.
 */
export function applyHardSafetyOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  if (!hasHardScamSignalsV2(rawText)) return result;

  // Override to scam, suspicious, strong safety steps
  return {
    ...(result as any),
    document_type: { category: "scam", confidence: "high" },
    legitimacy_assessment: {
      status: "suspicious",
      confidence: "high",
      summary_reason:
        language === "es"
          ? "Este documento contiene señales fuertes de estafa (por ejemplo: amenazas, solicitud de pagos inusuales, o presión)."
          : "This document contains strong scam indicators (e.g., threats, unusual payment requests, or pressure).",
    },
    what_this_means_for_you:
      language === "es"
        ? "Podría tratarse de una estafa. No compartas información personal ni realices pagos. Verifica por canales oficiales."
        : "This may be a scam. Do not share personal information or make payments. Verify via official channels.",
    step_by_step_actions: [
      {
        step: 1,
        title: language === "es" ? "No pagues ni respondas" : "Do not pay or respond",
        description:
          language === "es"
            ? "No envíes dinero, tarjetas de regalo ni criptomonedas. No respondas al mensaje."
            : "Do not send money, gift cards, or crypto. Do not respond to the message.",
        urgency: "high",
      },
      {
        step: 2,
        title: language === "es" ? "Verifica por tu cuenta" : "Verify independently",
        description:
          language === "es"
            ? "Si crees que podría ser real, busca el número oficial en el sitio web de la institución (no uses el número del documento)."
            : "If you think it could be real, find the official number on the institution’s website (don’t use the number in the document).",
        urgency: "high",
      },
      {
        step: 3,
        title: language === "es" ? "Reporta si es necesario" : "Report if needed",
        description:
          language === "es"
            ? "Si confirmas que es sospechoso, repórtalo a tu proveedor (banco, email) o a autoridades/consumidor."
            : "If confirmed suspicious, report it to your provider (bank/email) or consumer authorities.",
        urgency: "medium",
      },
    ],
    recommended_actions: [],
    red_flags: [
      language === "es" ? "Solicitud de pagos inusuales (tarjetas de regalo/cripto)." : "Unusual payment request (gift cards/crypto).",
      language === "es" ? "Lenguaje de amenazas o urgencia extrema." : "Threatening or extremely urgent language.",
    ],
    suggested_scripts: { call_script: null, email_template: null },
    safety_notes:
      language === "es"
        ? "No realice pagos, no comparta información personal y no responda a este mensaje."
        : "Do not make payments, do not share personal information, and do not respond to this message.",
  } as DoculeaResponse;
}

// ---------------- Government-like solicitations (NJ Annual Report style) ----------------

function looksLikeNjAnnualReportSolicitation(text: string): boolean {
  const t = (text || "").toLowerCase();

  const mustHave = ["annual report", "new jersey"];
  const signals = [
    "annual report compliance",
    "service fee",
    "order total",
    "make checks payable",
    "processing fee",
    "notice sent date",
    "respond by",
    "reference id",
    "princeton",
    "nassau street",
    "box",
  ];

  const hasMust = mustHave.every((m) => t.includes(m));
  const sigCount = signals.reduce((acc, s) => acc + (t.includes(s) ? 1 : 0), 0);

  return hasMust && sigCount >= 3;
}

/**
 * Re-labels NJ annual report solicitations as suspicious (non-official),
 * and prevents “pay this notice” behavior.
 */
export function applyGovernmentSolicitationOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  const cat = (result as any)?.document_type?.category;
  if (cat !== "government") return result;

  if (!looksLikeNjAnnualReportSolicitation(rawText)) return result;

  const next: any = { ...(result as any) };

  next.legitimacy_assessment = {
    status: "suspicious",
    confidence: "high",
    summary_reason:
      language === "es"
        ? "Este aviso parece ser una solicitud de una empresa privada que ofrece presentar el informe anual cobrando una tarifa adicional. No parece ser un aviso oficial del estado."
        : "This appears to be a private-company solicitation offering to file an annual report for an extra fee. It does not appear to be an official state notice.",
  };

  next.plain_language_summary =
    language === "es"
      ? "Este documento parece una solicitud (no oficial) para pagar por un servicio de presentación del informe anual. El informe anual puede existir, pero normalmente puedes presentarlo directamente en el portal oficial del estado por un costo menor."
      : "This appears to be a non-official solicitation to pay for an annual report filing service. The annual report may be real, but you can usually file directly on the state’s official portal for less.";

  next.what_this_means_for_you =
    language === "es"
      ? "No pagues este aviso sin verificar. Es probable que sea un servicio privado que se presenta como “oficial”. Verifica tu estatus en el portal oficial del estado y presenta allí si corresponde."
      : "Do not pay this notice without verifying. It’s likely a private service that looks ‘official’. Verify your status on the official state portal and file there if needed.";

  next.step_by_step_actions = [
    {
      step: 1,
      title: language === "es" ? "No pagues este aviso" : "Do not pay this notice",
      description:
        language === "es"
          ? "Evita enviar cheques o pagos a esta entidad hasta verificar si es oficial."
          : "Avoid sending checks/payments to this entity until you verify it’s official.",
      urgency: "high",
    },
    {
      step: 2,
      title: language === "es" ? "Verifica en el sitio oficial" : "Verify on the official site",
      description:
        language === "es"
          ? "Busca el portal oficial de Nueva Jersey para confirmar si tu informe anual está pendiente y cuál es la tarifa oficial."
          : "Use New Jersey’s official portal to confirm if your annual report is due and what the official fee is.",
      urgency: "high",
    },
    {
      step: 3,
      title: language === "es" ? "Presenta directamente (si aplica)" : "File directly (if needed)",
      description:
        language === "es"
          ? "Si está pendiente, presenta el informe en el portal oficial. Si necesitas ayuda, busca un contador/abogado por tu cuenta."
          : "If due, file through the official portal. If you need help, choose an accountant/lawyer independently.",
      urgency: "medium",
    },
  ];

  next.red_flags = Array.isArray(next.red_flags) ? next.red_flags : [];
  const rfs =
    language === "es"
      ? [
          "Parece oficial, pero puede ser una empresa privada.",
          "Incluye una 'service fee' además de la tarifa estatal.",
        ]
      : [
          "Looks official but may be a private company.",
          "Includes a 'service fee' on top of the state fee.",
        ];
  for (const r of rfs) if (!next.red_flags.includes(r)) next.red_flags.push(r);

  next.suggested_scripts = { call_script: null, email_template: null };
  next.safety_notes =
    language === "es"
      ? "No uses el número/email del aviso para verificar. Busca el portal oficial del estado y verifica allí."
      : "Do not use the notice’s number/email to verify. Use the state’s official portal to confirm status.";

  return next as DoculeaResponse;
}

// ---------------- E-commerce / order confirmation normalization ----------------

function looksLikeEcommerceOrderConfirmation(text: string): boolean {
  const t = (text || "").toLowerCase();
  const brandSignals = ["temu", "amazon", "walmart", "target", "shein", "aliexpress", "order confirmed", "pedido confirmado", "tracking"];
  const purchaseSignals = ["your purchase", "tu compra", "shipping", "envío", "address", "dirección", "order", "pedido"];
  const a = brandSignals.some((s) => t.includes(s));
  const b = purchaseSignals.some((s) => t.includes(s));
  return a && b;
}

/**
 * If it’s clearly an order confirmation, do NOT treat as scam/offer funnel by default.
 * Keep it informational and advise verifying inside the official app/site.
 */
export function applyEcommerceNormalizationOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  if (!looksLikeEcommerceOrderConfirmation(rawText)) return result;

  const next: any = { ...(result as any) };

  next.document_type = { category: "informational", confidence: "high" };
  next.legitimacy_assessment = {
    status: "likely_legit",
    confidence: "medium",
    summary_reason:
      language === "es"
        ? "Parece una confirmación de pedido de una plataforma conocida. Aun así, verifica dentro de la app/sitio oficial."
        : "This looks like an order confirmation from a known platform. Still, verify inside the official app/site.",
  };

  next.step_by_step_actions = [
    {
      step: 1,
      title: language === "es" ? "Verifica en la app/sitio oficial" : "Verify in the official app/site",
      description:
        language === "es"
          ? "Abre la app o el sitio oficial (por tu cuenta) y confirma que el pedido aparece en tu cuenta."
          : "Open the official app/site (independently) and confirm the order appears in your account.",
      urgency: "medium",
    },
    {
      step: 2,
      title: language === "es" ? "Revisa la dirección y el envío" : "Check address and shipping",
      description:
        language === "es"
          ? "Confirma dirección, artículos y fechas estimadas. Si no reconoces el pedido, cambia tu contraseña."
          : "Confirm address, items, and estimated dates. If you don’t recognize it, change your password.",
      urgency: "medium",
    },
    {
      step: 3,
      title: language === "es" ? "Evita enlaces sospechosos" : "Avoid suspicious links",
      description:
        language === "es"
          ? "Si el email tiene enlaces raros, no hagas clic. Entra por la app/sitio oficial."
          : "If the email has odd links, don’t click. Use the official app/site.",
      urgency: "low",
    },
  ];

  next.suggested_scripts = { call_script: null, email_template: null };
  next.red_flags = Array.isArray(next.red_flags) ? next.red_flags : [];
  next.safety_notes =
    language === "es"
      ? "Verifica siempre desde la app/sitio oficial. Si no reconoces el pedido, revisa tu cuenta y métodos de pago."
      : "Always verify from the official app/site. If you don’t recognize the order, review your account and payment methods.";

  return next as DoculeaResponse;
}

// ---------------- Intent + Pressure layer (offers vs obligations vs manipulative solicitations) ----------------

type IntentMode = "required_obligation" | "optional_offer" | "informational_notice" | "manipulative_solicitation" | "unknown";

function normalizeText(t: string) {
  return (t || "").toLowerCase();
}

function countMatches(haystack: string, needles: string[]): number {
  let c = 0;
  for (const n of needles) if (haystack.includes(n)) c++;
  return c;
}

function hasAny(haystack: string, needles: string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

function pressureScore(t: string): number {
  const s = normalizeText(t);
  const pressure = [
    "final notice",
    "immediate response",
    "urgent",
    "act now",
    "last day",
    "deadline",
    "expires",
    "expire date",
    "too late",
    "penalty",
    "lapse of coverage",
    "financial liable",
    "liability",
    "we reserve the right",
    "required",
    "must call",
    "call today",
    "respond by",
    // Spanish
    "aviso final",
    "respuesta inmediata",
    "urgente",
    "actúe ahora",
    "ultimo dia",
    "último día",
    "fecha límite",
    "vence",
    "expira",
    "demasiado tarde",
    "multa",
    "penalidad",
    "responsable",
    "debe llamar",
    "llame hoy",
    "responda antes de",
  ];
  return countMatches(s, pressure);
}

function offerScore(t: string): number {
  const s = normalizeText(t);

  const strong = [
    "offer",
    "promotion",
    "enroll",
    "enrollment",
    "sign up",
    "apply now",
    "reward",
    "cash back",
    "you must call",
    // Spanish strong
    "oferta",
    "promoción",
    "inscríbete",
    "inscribirse",
    "solicita ahora",
    "recompensas",
    "reembolso",
  ];

  const weak = [
    "register",
    "optional",
    "program",
    "benefits",
    "terms and conditions",
    "credit card",
    "registr",
    "opcional",
    "programa",
    "beneficios",
    "términos y condiciones",
    "tarjeta de crédito",
  ];

  const strongHits = countMatches(s, strong);
  const weakHits = countMatches(s, weak);

  // Weight strong higher; weak alone shouldn't trigger
  return strongHits * 2 + weakHits;
}


function utilitySwitchSignals(t: string): boolean {
  const s = normalizeText(t);
  const signals = [
    "third party supplier",
    "not affiliated",
    "electricity supplier",
    "remain a customer",
    "refund id",
    "bill credit",
    "supply charges",
    "bureau of public utilities",
    "pse&g",
    "pseg",
    "choose one",
    "mail me a check",
    "last day to call",
  ];
  return countMatches(s, signals) >= 3;
}

function likelyGovOrBillCategory(cat: any): boolean {
  return (
    cat === "government" ||
    cat === "utility" ||
    cat === "medical" ||
    cat === "bank" ||
    cat === "credit_card" ||
    cat === "debt_collection" ||
    cat === "insurance"
  );
}

/**
 * Intent + pressure normalization. This does NOT change your locked schema.
 * It only rewrites wording/actions to reduce harm and improve trust.
 */
export function applyIntentAndPressureOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  const text = String(rawText || "");
  const cat = (result as any)?.document_type?.category;
  const status = (result as any)?.legitimacy_assessment?.status;

  // If already hard-scam suspicious, do nothing here.
  if (status === "suspicious" && hasHardScamSignals(text)) return result;

  const pScore = pressureScore(text);
  const oScore = offerScore(text);

  let intent: IntentMode = "unknown";

  if (cat === "informational") {
    intent = "informational_notice";
  } else if (utilitySwitchSignals(text)) {
    intent = "manipulative_solicitation";
  } else if (oScore >= 2 && pScore >= 2) {
    intent = "manipulative_solicitation";
  } else if (oScore >= 2 && pScore <= 1) {
    intent = "optional_offer";
  } else if (
    likelyGovOrBillCategory(cat) &&
    pScore >= 2 &&
    hasAny(normalizeText(text), ["make checks payable", "order total", "service fee", "processing fee"])
  ) {
    intent = "manipulative_solicitation";
  } else if (likelyGovOrBillCategory(cat)) {
    intent = "required_obligation";
  }

  if (intent === "unknown") return result;

  const next: any = { ...(result as any) };

  const ensureRedFlags = () => {
    if (!Array.isArray(next.red_flags)) next.red_flags = [];
  };

  const addPrefixToSummary = (prefix: string) => {
    const s = String(next.plain_language_summary || "").trim();
    if (!s) return;
    if (s.toLowerCase().startsWith(prefix.toLowerCase())) return;
    next.plain_language_summary = `${prefix} ${s}`.trim();
  };

  if (intent === "optional_offer") {
    const prefix = language === "es" ? "Oferta opcional:" : "Optional offer:";
    addPrefixToSummary(prefix);

    const offerSafety =
      language === "es"
        ? "No estás obligado a inscribirte. Si te interesa, verifica detalles usando fuentes oficiales (sitio/app oficial) y evita usar enlaces/QR impresos."
        : "You’re not required to enroll. If interested, verify details via official sources (official site/app) and avoid printed QR/links.";

    if (!next.safety_notes) next.safety_notes = offerSafety;

    next.step_by_step_actions = [
      {
        step: 1,
        title: language === "es" ? "Revisa los detalles" : "Review the details",
        description:
          language === "es"
            ? "Lee costos, condiciones y qué incluye. Esto es opcional."
            : "Review costs, terms, and what’s included. This is optional.",
        urgency: "low",
      },
      {
        step: 2,
        title: language === "es" ? "Verifica por tu cuenta" : "Verify independently",
        description:
          language === "es"
            ? "Busca la entidad en el sitio/app oficial o canales verificados. Evita enlaces/QR impresos."
            : "Use the official site/app or verified channels. Avoid printed QR/links.",
        urgency: "low",
      },
      {
        step: 3,
        title: language === "es" ? "Decide si te conviene" : "Decide if it’s worth it",
        description:
          language === "es"
            ? "Compara alternativas y solo continúa si realmente lo necesitas."
            : "Compare alternatives and proceed only if you truly want it.",
        urgency: "low",
      },
    ];

    ensureRedFlags();
    const rfs =
      language === "es"
        ? ["Es una oferta opcional: no estás obligado a inscribirte."]
        : ["This is an optional offer: you are not required to enroll."];
    for (const r of rfs) if (!next.red_flags.includes(r)) next.red_flags.push(r);

    // Remove scripts by default for offers (avoid funneling). If you want them back later, we can add “official channels only” scripts.
    next.suggested_scripts = { call_script: null, email_template: null };
  }

  if (intent === "manipulative_solicitation") {
    ensureRedFlags();

    next.legitimacy_assessment = {
      status: next.legitimacy_assessment?.status === "suspicious" ? "suspicious" : "unclear",
      confidence: "high",
      summary_reason:
        language === "es"
          ? "Parece ser una solicitud/oferta opcional con lenguaje de presión (urgencia, fechas límite o amenazas). Esto puede empujarte a inscribirte o pagar sin necesidad. Verifica por canales oficiales antes de actuar."
          : "This appears to be an optional solicitation using pressure language (urgency, deadlines, or threats). This can funnel you into signing up or paying unnecessarily. Verify via official channels before acting.",
    };

    const prefix =
      language === "es"
        ? "Aviso comercial (opcional) con lenguaje de presión:"
        : "Optional solicitation with pressure language:";

    addPrefixToSummary(prefix);

    const rf = language === "es"
      ? [
          "Lenguaje de urgencia o 'aviso final'.",
          "Plazo/fecha límite para presionarte.",
          "Te pide llamar de inmediato o actuar sin verificación.",
        ]
      : [
          "Urgent or 'final notice' language.",
          "Deadline meant to pressure you.",
          "Asks you to call immediately or act without verification.",
        ];
    for (const r of rf) if (!next.red_flags.includes(r)) next.red_flags.push(r);

    next.step_by_step_actions = [
      {
        step: 1,
        title: language === "es" ? "No actúes por presión" : "Don’t act due to pressure",
        description:
          language === "es"
            ? "No llames ni pagues solo por esta carta/mensaje. Verifica primero."
            : "Don’t call or pay just because of this letter/message. Verify first.",
        urgency: "medium",
      },
      {
        step: 2,
        title: language === "es" ? "Verifica por fuentes oficiales" : "Verify via official sources",
        description:
          language === "es"
            ? "Busca la entidad por tu cuenta (sitio oficial, tu cuenta, o un número verificado). Evita enlaces/QR impresos."
            : "Look up the entity independently (official site, your account, or a verified number). Avoid printed QR/links.",
        urgency: "medium",
      },
      {
        step: 3,
        title: language === "es" ? "Decide si lo necesitas" : "Decide if you need it",
        description:
          language === "es"
            ? "Si es solo una oferta, puedes ignorarla. Si realmente aplica, continúa solo por canales oficiales."
            : "If it’s just an offer, you can ignore it. If it truly applies, proceed only via official channels.",
        urgency: "low",
      },
    ];

    next.suggested_scripts = { call_script: null, email_template: null };

    const s =
      language === "es"
        ? "Evita llamar al número o usar enlaces/QR impresos. Verifica primero en el sitio/app oficial o tu cuenta. No compartas información personal bajo presión."
        : "Avoid calling numbers or using printed QR/links. Verify first via the official site/app or your account. Don’t share personal info under pressure.";

    next.safety_notes = next.safety_notes ? String(next.safety_notes) : s;
  }

  if (intent === "required_obligation") {
    const safePay =
      language === "es"
        ? "Si este documento requiere pago o acción, hazlo solo por canales oficiales (portal oficial, tu cuenta, o un número verificado). Evita pagar a terceros no oficiales."
        : "If this requires payment or action, do it only via official channels (official portal, your account, or a verified number). Avoid paying non-official third parties.";

    if (!next.safety_notes) next.safety_notes = safePay;
  }

  return next as DoculeaResponse;
}


// -----------------------------
// Form intent + Government notice detection (for Form Mode gating)
// -----------------------------

export function isGovernmentNotice(text: string): boolean {
  const t = (text || "").toLowerCase();

  const signals = [
    "department of labor",
    "departamento de trabajo",
    "unemployment",
    "desempleo",
    "insurance benefits",
    "seguro de desempleo",
    "claim",
    "reclamo",
    "claimant",
    "reclamante",
    "determination",
    "determinación",
    "eligibility",
    "elegibilidad",
    "appointment",
    "cita",
    "hearing",
    "audiencia",
    "appeal",
    "apelación",
    "workforce",
    "new jersey department of labor",
    "njdol",
  ];

  return signals.some((s) => t.includes(s));
}

/**
 * Returns true when the user is expected to FILL OUT a form (interactive form intent),
 * not simply follow instructions in a notice.
 */
export function detectFormIntent(text: string): boolean {
  const t = (text || "").toLowerCase();

  // Phrases that explicitly ask the recipient to complete/return a form.
  const fillSignals = [
    "complete this form",
    "fill out this form",
    "please complete",
    "return this form",
    "questionnaire",
    "application form",
    "health history",
    "parent/guardian must complete",
    "student must complete",
    "tax form",
    "formulario",
    "complete el formulario",
    "por favor complete",
    "devuelva este formulario",
    "cuestionario",
    "solicitud",
    "historial de salud",
  ];

  const hasFillSignal = fillSignals.some((s) => t.includes(s));

  // Structural hints of an interactive form (checkbox / yes-no / signature).
  const structural =
    /yes\s*\/\s*no/.test(t) ||
    /\b(sí|si)\s*\/\s*no\b/.test(t) ||
    /\bsignature\b/.test(t) ||
    /\bfirma\b/.test(t) ||
    /\bdate\b/.test(t) ||
    /\bfecha\b/.test(t);

  const schoolMedicalContext =
    /\bparent\b|\bguardian\b|\bstudent\b|\bschool\b|\bdistrict\b|\bgrade\b/.test(t) ||
    /\bpadre\b|\btutor\b|\bestudiante\b|\bescuela\b|\bdistrito\b|\bgrado\b/.test(t) ||
    /\bmedical\b|\bdoctor\b|\bphysician\b|\bclinic\b|\bimmuniz/.test(t) ||
    /\bmédic\b|\bdoctor\b|\bclínic\b|\binmuniz/.test(t);

  // If it looks like a government notice (unemployment, determinations, hearings),
  // do NOT treat it as a form unless explicit fill signals exist.
  if (isGovernmentNotice(t) && !hasFillSignal) return false;

  if (hasFillSignal) return true;

  // Allow interactive forms that don't have explicit "complete this form" wording,
  // but have school/medical context + structural signals.
  if (schoolMedicalContext && structural) return true;

  return false;
}
