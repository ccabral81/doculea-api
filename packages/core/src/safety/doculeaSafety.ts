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

  // Also treat explicit "click here to verify" as escalation.
  const clickHere = /(click here|haga clic|haz clic|presiona aquí|presione aquí)/i.test(text);

  return patterns.some((p) => t.includes(p)) || clickHere;
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
