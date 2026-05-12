/* =============================================================================
   Cloudflare Worker — "Should You Buy It Here?" product lookup proxy
   -----------------------------------------------------------------------------
   The website (on GitHub Pages) calls this Worker. The Worker calls the Gemini
   API with Google Search grounding and returns a JSON object describing the
   product: brand, origin, category, a blurb, estimated per-country prices, an
   image URL, and the sources Gemini used.

   The Gemini API key is NEVER in this file or in the website — it's stored as a
   Cloudflare "secret" named GEMINI_API_KEY. (See worker/DEPLOY.md.)

   Endpoint:  GET  https://<your-worker>.workers.dev/?q=<product name>
   Example:   .../?q=Prada%20Brera%20bag
   ========================================================================== */

const COUNTRIES = ["United States","France","Italy","United Kingdom","Switzerland","Japan","South Korea"];

// You can change the model name if Google adds newer ones (check aistudio.google.com).
const MODEL = "gemini-2.5-flash";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ found: false, error: "Add ?q=<product name>" }, 400);
    if (q.length > 120) return json({ found: false, error: "Query too long" }, 400);
    if (!env.GEMINI_API_KEY) return json({ found: false, error: "Server missing GEMINI_API_KEY secret" }, 500);

    const prompt = buildPrompt(q);

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
          }),
        }
      );
    } catch (e) {
      return json({ found: false, error: "Could not reach Gemini: " + e.message }, 502);
    }

    if (!geminiRes.ok) {
      const t = await geminiRes.text();
      return json({ found: false, error: `Gemini API error ${geminiRes.status}`, detail: t.slice(0, 400) }, 502);
    }

    const data = await geminiRes.json();
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).map(p => p.text || "").join("\n");
    const sources = (cand?.groundingMetadata?.groundingChunks || [])
      .map(c => c?.web?.uri).filter(Boolean).slice(0, 6);

    const parsed = extractJson(text);
    if (!parsed) return json({ found: false, error: "Gemini did not return parseable data", raw: text.slice(0, 400) }, 200);

    // normalize & clamp prices to the known country list
    const prices = {};
    for (const c of COUNTRIES) {
      const v = parsed.prices?.[c];
      if (typeof v === "number" && isFinite(v) && v > 0) prices[c] = v;
    }

    return json({
      found: parsed.found !== false && Object.keys(prices).length >= 2,
      name: str(parsed.name) || q,
      brand: (str(parsed.brand) || "").toUpperCase() || "UNKNOWN BRAND",
      origin: str(parsed.origin) || "unknown",
      category: str(parsed.category) || "product",
      blurb: str(parsed.blurb) || "",
      image_url: cleanImageUrl(parsed.image_url),
      prices,
      currencies: { "United States":"USD","France":"EUR","Italy":"EUR","United Kingdom":"GBP","Switzerland":"CHF","Japan":"JPY","South Korea":"KRW" },
      sources,
      model: MODEL,
    }, 200);
  },
};

function buildPrompt(q) {
  return [
    `You are a meticulous research assistant. Use Google Search to find current, real information about this product: "${q}".`,
    `Identify the single specific product the user most likely means (a real, currently-sold item).`,
    `Return ONLY a JSON object — no markdown fences, no commentary before or after. Schema:`,
    `{`,
    `  "found": true | false,`,
    `  "name": "full product name as the brand calls it",`,
    `  "brand": "BRAND NAME",`,
    `  "origin": "country where the brand/house is based",`,
    `  "category": "short noun phrase, e.g. handbag / watch / pair of sneakers / belt",`,
    `  "blurb": "one sentence: what it is, and roughly how its production cost compares to its retail price (qualitative is fine)",`,
    `  "prices": {`,
    `    "United States": <number, in US dollars>,`,
    `    "France": <number, in euros>,`,
    `    "Italy": <number, in euros>,`,
    `    "United Kingdom": <number, in British pounds>,`,
    `    "Switzerland": <number, in Swiss francs>,`,
    `    "Japan": <number, in Japanese yen>,`,
    `    "South Korea": <number, in South Korean won>`,
    `  },`,
    `  "image_url": "a direct, hot-link-friendly URL to a clean photo of the product (https, ideally ending .jpg/.png/.webp). Prefer Wikimedia/Wikipedia if available. If unsure, use the best you can find."`,
    `}`,
    `Use realistic CURRENT retail prices in EACH country's OWN currency (not converted). If you genuinely cannot identify the product, set "found": false and you may omit prices.`,
  ].join("\n");
}

function extractJson(text) {
  if (!text) return null;
  // strip ```json fences if present
  let t = text.replace(/```json/gi, "```").trim();
  const fence = t.match(/```([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // find the first balanced {...}
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "{") depth++;
    else if (t[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function str(v) { return typeof v === "string" ? v.trim() : ""; }
function cleanImageUrl(v) {
  const s = str(v);
  if (!s) return "";
  try { const u = new URL(s); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}
