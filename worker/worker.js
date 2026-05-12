/* =============================================================================
   Cloudflare Worker — "Should You Buy It Here?" product lookup proxy
   -----------------------------------------------------------------------------
   Two endpoints:
     GET /?q=<product name>   → Gemini lookup, returns JSON with product data
     GET /img?url=<image url>  → Image proxy, bypasses hotlink protection
   ========================================================================== */

const COUNTRIES = ["United States","France","Italy","United Kingdom","Switzerland","Japan","South Korea"];
const MODEL = "gemini-2.5-flash";
const API_KEY_FALLBACK = "AIzaSyA_RxlBix7riczlYFCm5K9pnOd_lgvvzOs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Image proxy endpoint
    if (url.pathname === "/img") {
      return handleImageProxy(url);
    }

    // Product lookup endpoint
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ found: false, error: "Add ?q=<product name>" }, 400);
    if (q.length > 120) return json({ found: false, error: "Query too long" }, 400);

    const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
    const prompt = buildPrompt(q);

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
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

    const prices = {};
    for (const c of COUNTRIES) {
      const v = parsed.prices?.[c];
      if (typeof v === "number" && isFinite(v) && v > 0) prices[c] = v;
    }

    // Build proxied image URL so the browser can actually load it
    const rawImg = cleanImageUrl(parsed.image_url);
    const proxyImg = rawImg ? `${url.origin}/img?url=${encodeURIComponent(rawImg)}` : "";

    return json({
      found: parsed.found !== false && Object.keys(prices).length >= 2,
      name: str(parsed.name) || q,
      brand: (str(parsed.brand) || "").toUpperCase() || "UNKNOWN BRAND",
      origin: str(parsed.origin) || "unknown",
      category: str(parsed.category) || "product",
      blurb: str(parsed.blurb) || "",
      image_url: proxyImg,
      prices,
      currencies: { "United States":"USD","France":"EUR","Italy":"EUR","United Kingdom":"GBP","Switzerland":"CHF","Japan":"JPY","South Korea":"KRW" },
      sources,
      model: MODEL,
    }, 200);
  },
};

async function handleImageProxy(url) {
  const imgUrl = url.searchParams.get("url");
  if (!imgUrl) return new Response("Missing ?url=", { status: 400, headers: CORS });

  try {
    const imgRes = await fetch(imgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Referer": new URL(imgUrl).origin + "/",
      },
    });
    if (!imgRes.ok) return new Response("Image fetch failed", { status: 502, headers: CORS });

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const body = await imgRes.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return new Response("Proxy error: " + e.message, { status: 502, headers: CORS });
  }
}

function buildPrompt(q) {
  return [
    `You are a meticulous research assistant. Use Google Search to find current, real information about this product: "${q}".`,
    `Identify the single specific product the user most likely means (a real, currently-sold item).`,
    `Return ONLY a JSON object — no markdown fences, no commentary before or after. Schema:`,
    `{`,
    `  "found": true | false,`,
    `  "name": "full product name as the brand calls it",`,
    `  "brand": "BRAND NAME",`,
    `  "origin": "country where the brand/house is based (e.g. Italy for Gucci, France for Louis Vuitton, Switzerland for Rolex)",`,
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
    `  "image_url": "a direct URL to a clean product photo (https, ending in .jpg/.png/.webp). Strongly prefer Wikimedia Commons or Wikipedia images. Otherwise use official brand website images or well-known retail sites."`,
    `}`,
    `Use realistic CURRENT retail prices in EACH country's OWN currency (not converted). If you genuinely cannot identify the product, set "found": false and you may omit prices.`,
  ].join("\n");
}

function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "```").trim();
  const fence = t.match(/```([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
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
