export function hasHardScamSignals(text: string) {
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
