// Cloudflare Worker: secure AI chat proxy with streaming. Worker name: "smart-ai"
// Variables (Settings > Variables and Secrets):
//   ANTHROPIC_KEY  (Secret)  -> uses Anthropic API (paid)   OR
//   GEMINI_API_KEY (Secret)  -> uses Google Gemini API (free tier may be available - check AI Studio)
//   ALLOWED_ORIGIN (Text)    -> https://sirajuxdjk-code.github.io   (no path, no trailing slash)
//   GEMINI_MODEL   (optional)
export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("Smart Personality AI worker is running", { headers: cors });
    try {
      const { messages, stream } = await req.json();
      const msgs = (messages || []).slice(-14);
      if (env.ANTHROPIC_KEY) return anthropic(msgs, !!stream, env, cors);
      if (env.GEMINI_API_KEY) return gemini(msgs, !!stream, env, cors);
      return Response.json({ error: "AI key set nahi hai. Worker Variables me ANTHROPIC_KEY ya GEMINI_API_KEY daalein." }, { status: 500, headers: cors });
    } catch (e) {
      return Response.json({ error: "Server error" }, { status: 500, headers: cors });
    }
  },
};

async function anthropic(msgs, stream, env, cors) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 2000, messages: msgs, stream }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); return Response.json({ error: d.error?.message || "AI error" }, { status: r.status, headers: cors }); }
  if (stream) return new Response(r.body, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  const d = await r.json();
  return Response.json({ text: d.content.map((c) => c.text || "").join("") }, { headers: cors });
}

async function gemini(msgs, stream, env, cors) {
  const contents = msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  const models = [env.GEMINI_MODEL, "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean);
  let err = "Gemini error", st = 502;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      err = d.error?.message || err; st = r.status;
      if (/api key|permission|quota|billing/i.test(err) || [401, 403, 429].includes(r.status)) break;
      continue;
    }
    if (!stream) { const d = await r.json(); return Response.json({ text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("") }, { headers: cors }); }
    const enc = new TextEncoder(), dec = new TextDecoder(); let buf = "";
    const ts = new TransformStream({ transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const ls = buf.split("\n"); buf = ls.pop();
      for (const l of ls) {
        if (!l.startsWith("data:")) continue;
        try { const j = JSON.parse(l.slice(5)); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); if (t) ctl.enqueue(enc.encode("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } }) + "\n\n")); } catch (e) {}
      }
    } });
    return new Response(r.body.pipeThrough(ts), { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  return Response.json({ error: err }, { status: st, headers: cors });
}
