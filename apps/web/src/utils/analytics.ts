function getDevice(){
  if (typeof navigator === "undefined") return "server";
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)?"mobile":"desktop";
}

export function getSessionId(): string {
  if (typeof window === "undefined") return "server";

  const k = "doculea_session_id";
  let v = localStorage.getItem(k);

  if (!v) {
    const hasUUID =
      typeof globalThis.crypto !== "undefined" &&
      typeof globalThis.crypto.randomUUID === "function";

    v = hasUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    localStorage.setItem(k, v);
  }

  return v;
}


export async function logEvent(event: string, extra: Record<string, any> = {}) {
  if (process.env.NEXT_PUBLIC_DOCULEA_DISABLE_LOGS === "1") return;
  const sessionId = getSessionId();
  try {
    await fetch("/api/doculea/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        tsClient: new Date().toISOString(),
        lang: extra.lang,
        device: getDevice(),
        route: "/doculea-test",
        ...extra,       // first
        sessionId,      // last (cannot be overwritten)
      }),
    });
  } catch {}
}
