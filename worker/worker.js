/* =============================================================================
   Cloudflare Worker — "Should You Buy It Here?" product lookup proxy
   -----------------------------------------------------------------------------
   Two endpoints:
     GET /?q=<product name>   → Gemini lookup, returns JSON with product data
     GET /img?url=<image url>  → Image proxy, bypasses hotlink protection
   ========================================================================== */

const COUNTRIES = ["United States","Canada","France","Italy","United Kingdom","Switzerland","Japan","South Korea"];
const VALID_CURRENCIES = ["USD","CAD","EUR","GBP","CHF","JPY","KRW"];
const CURRENCY_OF = {
  "United States":"USD","Canada":"CAD","France":"EUR","Italy":"EUR",
  "United Kingdom":"GBP","Switzerland":"CHF","Japan":"JPY","South Korea":"KRW"
};
// Fallback only — value of 1 unit in USD — used if the live FX API is unreachable.
const FX_FALLBACK_USD = { USD:1, CAD:0.73, EUR:1.08, GBP:1.27, CHF:1.12, JPY:0.0064, KRW:0.00073 };
const MODEL = "gemini-2.5-flash";
const API_KEY_FALLBACK = ""; // set GEMINI_API_KEY as Cloudflare Worker secret

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    // Image debranding endpoint
    if (url.pathname === "/debrand" && request.method === "POST") {
      return handleDebrand(request, env);
    }

    // Product lookup endpoint
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ found: false, error: "Add ?q=<product name>" }, 400);
    if (q.length > 120) return json({ found: false, error: "Query too long" }, 400);

    // The display currency the user picked on the site (defaults to USD).
    let displayCur = (url.searchParams.get("currency") || "USD").trim().toUpperCase();
    if (!VALID_CURRENCIES.includes(displayCur)) displayCur = "USD";

    // Fetch real, current exchange rates in parallel with the Gemini lookup.
    const ratesPromise = getRates(displayCur);

    const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
    const prompt = buildPrompt(q, displayCur);

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
            generationConfig: { temperature: 0, maxOutputTokens: 8192 },
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

    // Convert each market's local price to the display currency using REAL current rates.
    const rates = (await ratesPromise) || fallbackRates(displayCur);
    const prices = {};       // each market's price in its OWN currency
    const homePrices = {};   // each market's price converted to the user's display currency
    for (const c of COUNTRIES) {
      const v = parsed.prices?.[c];
      if (typeof v !== "number" || !isFinite(v) || v <= 0) continue;
      prices[c] = v;
      const rate = rates[CURRENCY_OF[c]];
      if (typeof rate === "number" && rate > 0) homePrices[c] = Math.round(v / rate);
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
      macro_insight: str(parsed.macro_insight) || "",
      image_url: proxyImg,
      prices,
      home_prices: homePrices,
      home_currency: displayCur,
      fx_date: rates.__date || null,
      currencies: CURRENCY_OF,
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

async function handleDebrand(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { image, mimeType } = body;
  if (!image || typeof image !== "string") {
    return json({ success: false, error: "Missing 'image' (base64 string)" }, 400);
  }

  const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
  const prompt = [
    "You are an image editor that removes brand identifiers from product photos.",
    "",
    "RULES:",
    "1. Only remove visible brand logos, monograms, brand name text, and iconic brand patterns (e.g. LV monogram, Gucci stripe). Replace each removed area with the surrounding material's texture, color, and grain so it looks natural.",
    "2. If you cannot find any logo or brand marking in the image, return the image COMPLETELY UNCHANGED. Do not modify it at all.",
    "3. Do NOT alter anything else: keep the exact same colors, lighting, shadows, background, composition, resolution, and aspect ratio. The only difference should be the removed logos.",
  ].join("\n");

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
            ],
          }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      }
    );
  } catch (e) {
    return json({ success: false, error: "Could not reach Gemini: " + e.message }, 502);
  }

  if (!geminiRes.ok) {
    const t = await geminiRes.text();
    return json({ success: false, error: `Gemini API error ${geminiRes.status}`, detail: t.slice(0, 400) }, 502);
  }

  const data = await geminiRes.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);

  if (!imgPart) {
    return json({ success: false, error: "Gemini did not return an edited image" }, 200);
  }

  const img = imgPart.inlineData || imgPart.inline_data;
  return json({
    success: true,
    image: img.data,
    mimeType: img.mimeType || img.mime_type || "image/png",
  }, 200);
}

function buildPrompt(q, displayCur) {
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
    `  "prices": {            // each market's REAL current retail price in that country's OWN currency`,
    `    "United States": <number, in US dollars>,`,
    `    "Canada": <number, in Canadian dollars>,`,
    `    "France": <number, in euros>,`,
    `    "Italy": <number, in euros>,`,
    `    "United Kingdom": <number, in British pounds>,`,
    `    "Switzerland": <number, in Swiss francs>,`,
    `    "Japan": <number, in Japanese yen>,`,
    `    "South Korea": <number, in South Korean won>`,
    `  },`,
    `  "image_url": "a direct URL to a clean product photo (https, ending in .jpg/.png/.webp). Strongly prefer Wikimedia Commons or Wikipedia images. Otherwise use official brand website images or well-known retail sites.",`,
    `  "macro_insight": "ONE concise sentence (≤ 35 words) tying THIS specific result to ONE AP Macroeconomics concept — pick the most relevant from: exchange rates / currency depreciation, purchasing power parity / law of one price, tariffs & VAT / import duties, net exports / shopping tourism, or home-country origin advantage. Be specific about which country is cheapest and WHY (e.g. 'Switzerland is cheapest because its 8.1% VAT is the lowest in this set AND it's the brand's home country — origin advantage amplified by low tax.')."`,
    `}`,
    `Rules: Return a price for EVERY one of the eight countries (never null, 0, or "N/A"), each in that country's OWN local currency. Do NOT convert anything — currency conversion is handled separately with live exchange rates, so just give the real local sticker price. Luxury brands set DIFFERENT prices per region, so reflect the GENUINE regional differences from the brand's official local pricing (e.g. European and Japanese list prices are often lower than North America; Switzerland's VAT is low) — do NOT make the markets identical or copy one figure across countries. Prefer the brand's own country websites or reputable local retailers. If a market's exact price isn't published, estimate it from the brand's known regional pricing pattern. Plain numbers only: no currency symbols, no thousands separators. Only set "found": false if you cannot identify the product at all.`,
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

// Live exchange rates from the ECB via frankfurter.app (free, no key).
// Returns { CUR: units of CUR per 1 `base` }, including base:1, plus __date.
async function getRates(base) {
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`);
    if (!r.ok) return null;
    const d = await r.json();
    const rates = (d && d.rates) ? d.rates : {};
    rates[base] = 1;
    rates.__date = (d && d.date) || null;
    // Bail to fallback if a currency we need is missing.
    for (const c of VALID_CURRENCIES) if (typeof rates[c] !== "number") return null;
    return rates;
  } catch (e) {
    return null;
  }
}

// Cross-rates from the static USD table, used only if the live API is unreachable.
function fallbackRates(base) {
  const r = { __date: null };
  for (const k of VALID_CURRENCIES) r[k] = FX_FALLBACK_USD[base] / FX_FALLBACK_USD[k];
  return r;
}
