function getDevice(){
  if (typeof navigator === "undefined") return "sever";
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)?"mobile":"desktop";
}

function getSessionId(): string {
  if (typeof window === "undefined") return "server";
  const k = "doculea_session_id";
  let v = localStorage.getItem(k);
  if (v===null) {
    v =     
    typeof crypto !== "undefined" && "randomUUID" in crypto
    ?crypto.randomUUID()
    : String(Date.now());
    localStorage.setItem(k, v);
  }
  return v;
}

export async function logEvent(event: string, extra: Record<string, any>={}) {
  const sessionId =getSessionId();
  try {
    await fetch("/api/doculea/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        tsClient: new Date().toISOString(),
        sessionId,
        lang: extra.lang,
        device: getDevice(),
        route:"/doculea-test",
        ...extra,
      }),
    });
  } catch {
    // ignore logging failures
  }
}