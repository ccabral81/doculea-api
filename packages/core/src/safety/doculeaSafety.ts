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
  return patterns.some(p => t.includes(p));
}


/**
 * E-commerce / order confirmation normalization.
 * Goal: prevent inconsistent "scam" labeling for normal order confirmations when OCR is partial.
 * This runs AFTER hard-scam override and can downshift suspicious -> unclear when appropriate.
 */
function looksLikeOrderConfirmation(text: string): boolean {
  const t = (text || "").toLowerCase();

  // Core order confirmation signals (ES/EN)
  const orderSignals = [
    "pedido confirmado",
    "confirmación de tu pedido",
    "confirmacion de tu pedido",
    "tu compra está confirmada",
    "tu compra esta confirmada",
    "order confirmed",
    "order confirmation",
    "your order is confirmed",
    "purchase confirmed",
    "pedido 1 de",
    "tracking",
    "envío",
    "enviado",
    "shipping",
  ];

  // Merchant hints (expand over time; start small)
  const merchantHints = [
    "temu",
    "amazon",
    "walmart",
    "shein",
    "aliexpress",
    "ebay",
    "etsy",
    "target",
  ];

  const hasOrder = orderSignals.some((p) => t.includes(p));
  const hasMerchant = merchantHints.some((m) => t.includes(m));
  return hasOrder && hasMerchant;
}

function hasPhishingEscalationSignals(text: string): boolean {
  const t = (text || "").toLowerCase();

  // Signals that commonly indicate phishing / credential harvesting / payment fraud
  const patterns = [
    "verify your account",
    "confirm your account",
    "confirm your password",
    "reset password",
    "password reset",
    "log in",
    "login",
    "sign in",
    "update payment",
    "payment method",
    "billing information",
    "your account will be suspended",
    "account suspended",
    "unauthorized purchase",
    "suspicious activity",
    "urgent action required",
    "act now",

    // Spanish
    "verifica tu cuenta",
    "verificar tu cuenta",
    "confirma tu cuenta",
    "restablecer contraseña",
    "cambiar contraseña",
    "iniciar sesión",
    "inicia sesión",
    "actualiza tu pago",
    "método de pago",
    "metodo de pago",
    "información de facturación",
    "informacion de facturacion",
    "tu cuenta será suspendida",
    "tu cuenta sera suspendida",
    "actividad sospechosa",
    "compra no autorizada",
    "acción urgente",
    "accion urgente",
  ];
  // Treat "click here" as escalation ONLY when paired with account/payment/credential language.
  const clickHere = /(click here|haga clic|haz clic|presiona aquí|presione aquí)/i.test(text);
  const clickContext = /(account|cuenta|password|contrase|login|iniciar sesi|sign in|payment|pago|billing|factur|verify your account|verifica tu cuenta)/i.test(
    text
  );

  return patterns.some((p) => t.includes(p)) || (clickHere && clickContext);
}

function hasSenderOrDomainHint(text: string): boolean {
  const t = (text || "").toLowerCase();
  // Lightweight: if OCR captured a clear domain line, we consider it stronger.
  return (
    /\b(transaction\.|order\.|mail\.|notifications\.|no-reply\.)/.test(t) ||
    /\btemu\.com\b/.test(t) ||
    /\bamazon\.com\b/.test(t) ||
    /\bwalmart\.com\b/.test(t) ||
    /\bshein\.com\b/.test(t)
  );
}

/**
 * Applies deterministic normalization for order confirmations:
 * - If it looks like an order confirmation AND no phishing escalation signals:
 *   - Ensure NOT labeled as scam/suspicious.
 *   - Prefer likely_legit when sender/domain hint exists, otherwise unclear.
 *   - Remove scripts (no calling / emailing merchants based on an email screenshot).
 */
export function applyEcommerceNormalizationOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  const combined = (rawText || "").toString();
  if (!looksLikeOrderConfirmation(combined)) return result;

  // If hard scam override already triggered (e.g., gift cards, crypto, etc.), do not soften it.
  // (Those cases are not normal order confirmations.)
  if (result?.document_type?.category === "scam" && result?.legitimacy_assessment?.status === "suspicious") {
    if (hasHardScamSignals(combined) || hasPhishingEscalationSignals(combined)) return result;
  }

  const escalation = hasPhishingEscalationSignals(combined);
  if (escalation) return result; // let suspicious stand when escalation signals exist

  const stronger = hasSenderOrDomainHint(combined);

  const next = { ...result };

  // Ensure category is not "scam" for normal confirmations
  if (next?.document_type?.category === "scam") {
    next.document_type = { category: "informational", confidence: "medium" };
  }

  // Legitimacy: likely_legit if we have sender/domain, else unclear (missing OCR signals)
  next.legitimacy_assessment = {
    status: stronger ? "likely_legit" : "unclear",
    confidence: stronger ? "medium" : "medium",
    summary_reason:
      language === "es"
        ? stronger
          ? "Parece una confirmación normal de pedido de una plataforma conocida. No se observan señales claras de phishing en el texto detectado."
          : "Parece una confirmación de pedido, pero el texto detectado no incluye suficiente información del remitente. Verifica dentro de la app/sitio oficial."
        : stronger
          ? "This looks like a normal order confirmation from a known platform. No clear phishing escalation signals were detected."
          : "This appears to be an order confirmation, but the detected text lacks enough sender details. Verify inside the official app/site.",
  };

  // Safe steps for order confirmations (no scripts)
  next.step_by_step_actions =
    language === "es"
      ? [
          { step: 1, title: "Verifica dentro de la app o sitio oficial", description: "Abre la app oficial (o escribe la URL manualmente) y revisa tu sección de Pedidos/Órdenes.", urgency: "medium" },
          { step: 2, title: "Si NO hiciste esta compra", description: "No hagas clic en enlaces del correo. Entra a tu cuenta por la app/sitio oficial y revisa actividad reciente. Cambia tu contraseña si ves algo extraño.", urgency: "high" },
          { step: 3, title: "Evita enlaces si tienes dudas", description: "Si el mensaje te genera dudas, ignora enlaces/botones del correo y busca soporte desde la app o sitio oficial.", urgency: "medium" },
        ]
      : [
          { step: 1, title: "Verify inside the official app or site", description: "Open the official app (or type the URL manually) and check your Orders section.", urgency: "medium" },
          { step: 2, title: "If you did NOT place this order", description: "Do not click links in the email. Log in via the official app/site, review recent activity, and change your password if anything looks off.", urgency: "high" },
          { step: 3, title: "Avoid links if unsure", description: "If you’re unsure, ignore email buttons/links and use support from the official app or website.", urgency: "medium" },
        ];

  // Remove scripts to avoid driving contact based on a screenshot
  next.suggested_scripts = { call_script: "", email_template: "" };
  next.recommended_actions = [];

  // Red flags: only add when unclear or when user didn't place the order
  if (!Array.isArray(next.red_flags)) next.red_flags = [];
  if (!stronger) {
    const rf =
      language === "es"
        ? "El remitente/dominio no se pudo confirmar con el texto detectado. Verifica el pedido directamente en la app o sitio oficial."
        : "Sender/domain could not be confirmed from the detected text. Verify the order directly in the official app or website.";
    if (!next.red_flags.includes(rf)) next.red_flags.unshift(rf);
  }

  // Safety notes: gentle, not scary
  const note =
    language === "es"
      ? "Consejo: Si tienes dudas, no uses enlaces del correo. Entra a la app o escribe la URL manualmente."
      : "Tip: If you’re unsure, don’t use email links. Open the app or type the URL manually.";
  next.safety_notes = next.safety_notes ? `${next.safety_notes}\n\n${note}` : note;

  return next;
}


/**
 * Government-like solicitations that mimic official notices (example: NJ annual report solicitation).
 * These are often NOT from the government, even if they reference state fees.
 *
 * Rule:
 *  - If document is classified as government AND text contains strong solicitation fingerprints,
 *    force status to suspicious (high) and replace steps with "verify & file directly".
 */
function looksLikeNjAnnualReportSolicitation(text: string): boolean {
  const t = (text || "").toLowerCase();

  const signals = [
    "annual report compliance",
    "annualrcompliance.org",
    "make checks payable to",
    "service fee",
    "order total",
    "princeton, nj 08542",
    "nassau street",
    "po box",
  ];

  const hits = signals.reduce((acc, s) => (t.includes(s) ? acc + 1 : acc), 0);

  const has75 = /\$?\s?75\b/.test(t);
  const has170 = /\$?\s?170\b/.test(t);
  const hasServiceFee = t.includes("service fee");

  return hits >= 2 || (has75 && has170 && hasServiceFee);
}

export function applyGovernmentSolicitationOverride(
  result: DoculeaResponse,
  rawText: string,
  language: "en" | "es"
): DoculeaResponse {
  const combined = String(rawText || "");
  const category = (result as any)?.document_type?.category;

  // Only apply to government-ish classification
  if (category !== "government") return result;

  if (!looksLikeNjAnnualReportSolicitation(combined)) return result;

  const next: any = { ...(result as any) };

  next.legitimacy_assessment = {
    status: "suspicious",
    confidence: "high",
    summary_reason:
      language === "es"
        ? "Este aviso parece ser una solicitud de una empresa privada que ofrece presentar el informe anual cobrando una tarifa adicional. No parece ser un aviso oficial del estado."
        : "This appears to be a third-party solicitation offering to file your annual report for an extra fee; it does not appear to be an official state notice.",
  };

  // Ensure this reads like a solicitation, not an official mandate to pay them.
  const suffix =
    language === "es"
      ? " Puedes presentar el informe anual directamente con el Estado de Nueva Jersey por un costo menor."
      : " You can file the annual report directly with the State of New Jersey for a lower cost.";

  if (typeof next.plain_language_summary === "string") {
    if (!next.plain_language_summary.includes(suffix.trim())) {
      next.plain_language_summary = next.plain_language_summary.trim() + suffix;
    }
  }

  next.what_this_means_for_you =
    language === "es"
      ? "El requisito del informe anual puede ser real, pero este aviso parece ser de una empresa privada que cobra una tarifa adicional para hacerlo por ti. Verifica en el portal oficial del estado y presenta directamente si corresponde."
      : "The annual report requirement may be real, but this notice appears to be from a private company charging an extra service fee. Verify on the official state portal and file directly if needed.";

  next.step_by_step_actions =
    language === "es"
      ? [
          {
            step: 1,
            title: "No pagues este aviso",
            description:
              "Este documento parece ser una solicitud de una empresa privada. No envíes pago hasta verificar en el sitio oficial del estado.",
            urgency: "high",
          },
          {
            step: 2,
            title: "Verifica en el portal oficial",
            description:
              "Busca el portal oficial del Estado de NJ para confirmar si tu informe anual está pendiente y el costo oficial.",
            urgency: "high",
          },
          {
            step: 3,
            title: "Presenta directamente si corresponde",
            description:
              "Si está pendiente, presenta el informe anual directamente con el estado para evitar tarifas extra.",
            urgency: "medium",
          },
        ]
      : [
          {
            step: 1,
            title: "Do not pay this notice",
            description:
              "This appears to be a private solicitation. Don’t send payment until you verify on the official state site.",
            urgency: "high",
          },
          {
            step: 2,
            title: "Verify on the official state portal",
            description:
              "Use the official NJ state portal to confirm whether your annual report is due and the official fee.",
            urgency: "high",
          },
          {
            step: 3,
            title: "File directly if needed",
            description:
              "If it’s due, file directly with the state to avoid unnecessary service fees.",
            urgency: "medium",
          },
        ];

  // No scripts for solicitations
  next.suggested_scripts = { call_script: null, email_template: null };

  next.red_flags = [
    ...(Array.isArray(next.red_flags) ? next.red_flags : []),
    language === "es" ? "Incluye una tarifa de servicio adicional." : "Includes an extra service fee.",
    language === "es" ? "El remitente parece ser una empresa privada, no el estado." : "Sender appears to be a private company, not the state.",
  ];

  next.safety_notes =
    language === "es"
      ? "No envíes pagos ni información sensible usando los datos de este aviso. Verifica siempre con el portal oficial del estado."
      : "Do not send payment or sensitive info using the details on this notice. Always verify via the official state portal.";

  return next as DoculeaResponse;
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
  // If no hard scam signals, return result untouched
  if (!hasHardScamSignals(rawText)) {
    return result;
  }

  // Force scam classification if hard signals exist
  return {
    ...result,
    document_type: {
      category: "scam",
      confidence: "high",
    },
    legitimacy_assessment: {
      status: "suspicious",
      confidence: "high",
      summary_reason:
        language === "es"
          ? "El documento contiene señales claras de estafa, como solicitudes de pago inusuales o amenazas."
          : "The document contains strong scam indicators such as unusual payment requests or threats.",
    },
    safety_notes:
      language === "es"
        ? "No realice pagos, no comparta información personal y no responda a este mensaje."
        : "Do not make payments, do not share personal information, and do not respond to this message.",
  };
}
