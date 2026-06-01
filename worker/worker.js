/* =============================================================================
   Cloudflare Worker — "Should You Buy It Here?" product lookup proxy
   -----------------------------------------------------------------------------
   Endpoints:
     POST /scrape    → scrape official per-country pages, verify, return prices JSON
     POST /debrand   → Gemini image edit: remove brand logos from a product photo
     GET  /img?url=  → image proxy (bypasses origin hotlink protection)
   ========================================================================== */

import { scrapeAll } from "./scrape-core.mjs";

const VALID_CURRENCIES = ["USD","CAD","EUR","GBP","CHF","JPY","KRW"];
// Fallback only — value of 1 unit in USD — used if the live FX API is unreachable.
const FX_FALLBACK_USD = { USD:1, CAD:0.73, EUR:1.08, GBP:1.27, CHF:1.12, JPY:0.0064, KRW:0.00073 };
const MODEL = "gemini-2.5-flash";
const API_KEY_FALLBACK = ""; // set GEMINI_API_KEY as Cloudflare Worker secret

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ---------- Domain helpers ---------- */

const BLOCKED_DOMAINS = new Set([
  "farfetch.com","ssense.com","net-a-porter.com","mytheresa.com",
  "matchesfashion.com","nordstrom.com","saksfifthavenue.com",
  "bloomingdales.com","selfridges.com","harrods.com",
  "amazon.com","ebay.com","stockx.com","grailed.com","vestiairecollective.com",
]);

function bareDomain(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function preValidateUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch {
    return { valid: false, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, reason: "URL must be http(s)" };
  }
  const domain = bareDomain(parsed.hostname);
  if (BLOCKED_DOMAINS.has(domain)) {
    return { valid: false, reason: `Third-party retailer (${domain}) — please use the official brand URL` };
  }
  return { valid: true, domain, parsed };
}

/* ---------- POST /scrape handler ---------- */

async function handleScrape(request, env, url) {
  let body;
  try { body = await request.json(); } catch {
    return json({ found: false, error: "Invalid JSON body" }, 400);
  }

  // Strip tracking params from the pasted URL.
  let inputUrl = (body.url || "").trim();
  try {
    const u = new URL(inputUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|gbraid|gclsrc|gad_|fbclid|mc_|ref$|srsltid)/.test(key)) u.searchParams.delete(key);
    }
    inputUrl = u.toString();
  } catch { /* leave as-is */ }

  const homeCurrency = (body.homeCurrency || body.currency || "USD").trim().toUpperCase();
  if (!inputUrl) return json({ found: false, error: "Missing 'url' in request body" }, 400);
  if (!VALID_CURRENCIES.includes(homeCurrency)) {
    return json({ found: false, error: `Invalid homeCurrency: ${homeCurrency}` }, 400);
  }

  // Reject obvious resellers/marketplaces (official-site-only, per the design).
  const pre = preValidateUrl(inputUrl);
  if (!pre.valid) return json({ found: false, error: pre.reason }, 400);

  const FIRECRAWL_KEY = env.FIRECRAWL_API_KEY || "";
  if (!FIRECRAWL_KEY) return json({ found: false, error: "Server missing FIRECRAWL_API_KEY secret" }, 500);

  // 24h cache (Cloudflare Cache API; guarded so node tests still run).
  // refresh:true (or nocache:true) bypasses a cached hit AND overwrites it — needed because the
  // tracking-param stripper makes ?nocache=... in the URL useless for cache-busting (same key).
  const noCache = body.refresh === true || body.nocache === true;
  const cache = (typeof caches !== "undefined" && caches.default) ? caches.default : null;
  const cacheKey = `https://cache.scrape/?u=${encodeURIComponent(inputUrl)}&c=${homeCurrency}`;
  if (cache && !noCache) { const hit = await cache.match(cacheKey); if (hit) return hit; }

  // Core: scrape all 8 official country pages directly, verify, never fake.
  // visionFn = fallback used ONLY when text extraction fails for a country: screenshot the page
  // (closing locale modals via Escape) and read the price off the image with Gemini vision. The
  // result still passes scrape-core's currency + sanity gate, so it can't introduce a bad price.
  const GEMINI_KEY_V = env.GEMINI_API_KEY || "";
  const visionFn = GEMINI_KEY_V
    ? (u, country, wantCur) => visionExtractPrice(u, country, wantCur, FIRECRAWL_KEY, GEMINI_KEY_V)
    : null;
  const ratesPromise = getRates(homeCurrency);
  const core = await scrapeAll(inputUrl, FIRECRAWL_KEY, fetch, visionFn);
  if (!core.found) {
    return json({ found: false, error: core.error || "Could not read official prices for that link", failed: core.failed || [] }, 200);
  }

  // Build local + home-currency price maps.
  const rates = (await ratesPromise) || fallbackRates(homeCurrency);
  const prices = {}, localPrices = {}, homePrices = {};
  for (const [country, info] of Object.entries(core.prices)) {
    prices[country] = { price: info.price, currency: info.currency, available: true, via: info.via || "text" };
    localPrices[country] = info.price;
    const rate = rates[info.currency];
    if (typeof rate === "number" && rate > 0) homePrices[country] = Math.round(info.price / rate);
  }
  const failed = (core.failed || []).map(f => ({ country: f.country, available: false, reason: f.reason }));

  // Enrich (origin/category/blurb/brand) + macro insight via Gemini — best-effort, optional.
  const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
  let enrich = {};
  if (GEMINI_KEY) {
    enrich = await geminiEnrich(inputUrl, core.name, homeCurrency, homePrices, GEMINI_KEY) || {};
  }

  // Proxy the scraped product image so the browser can load it (hotlink-protected origins).
  const rawImg = cleanImageUrl(core.image);
  const proxyImg = rawImg ? `${url.origin}/img?url=${encodeURIComponent(rawImg)}` : "";

  const resp = json({
    found: true,
    url: inputUrl,
    product: {
      name: str(core.name) || str(enrich.name) || "Product",
      brand: (str(enrich.brand) || "").toUpperCase() || "UNKNOWN BRAND",
      origin: str(enrich.origin) || "unknown",
      category: str(enrich.category) || "product",
      image_url: proxyImg,
      blurb: str(enrich.blurb) || "",
    },
    prices,
    local_prices: localPrices,
    home_prices: homePrices,
    home_currency: homeCurrency,
    fx_date: rates.__date || null,
    failed,
    macro_insight: str(enrich.macro_insight) || "",
  }, 200);

  if (cache) {
    resp.headers.set("Cache-Control", "public, max-age=86400");
    try { await cache.put(cacheKey, resp.clone()); } catch {}
  }
  return resp;
}

// Gemini enrichment: brand/origin/category/blurb + one macro-insight sentence. Best-effort.
async function geminiEnrich(inputUrl, productName, homeCurrency, homePrices, geminiKey) {
  const prompt = [
    `A luxury product was found at: ${inputUrl} (name: "${productName || "unknown"}").`,
    `Its verified retail prices, converted to ${homeCurrency}, by country: ${JSON.stringify(homePrices)}.`,
    `VAT/consumption tax per market (tax-INCLUSIVE in the listed price, except the US where sales tax is added at the register): US none, Canada 5% GST + provincial, France 20%, Italy 22%, United Kingdom 20%, Switzerland 8.1%, Japan 10%, South Korea 10%.`,
    `Return ONLY a JSON object:`,
    `{ "brand": "BRAND", "origin": "country the brand/house is based in", "category": "short noun phrase e.g. handbag/watch", "blurb": "one sentence on what it is and how production cost compares to retail", "macro_insight": "ONE accurate sentence (<=35 words) linking THIS result to one AP Macro concept (exchange rates / PPP & law of one price / VAT & tariffs / shopping tourism / origin advantage). Name the cheapest market and the REAL reason, consistent with the VAT figures above. Rules: a market can be cheapest DESPITE high VAT when its pre-tax list price is set low — NEVER claim low or favorable VAT causes a low price unless that market's VAT above is actually among the lowest in the set; the EU is a single market with NO internal tariffs, so do NOT cite EU tariff structures; if the brand's home country ties for cheapest, attribute it to origin advantage (no import duty at the source)." }`,
  ].join("\n");
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      { method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ contents:[{ role:"user", parts:[{ text: prompt }] }],
          tools:[{ google_search:{} }], generationConfig:{ temperature:0, maxOutputTokens:4096 } }) }
    );
    if (!res.ok) return {};
    const d = await res.json();
    const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    return extractJson(text) || {};
  } catch { return {}; }
}

// Vision fallback: screenshot the product page (closing locale modals) and read price+currency
// off the image with Gemini vision. Returns {price, currency, name} or null. The caller
// (scrape-core) re-checks currency + sanity, so a misread can only fail, never inject a bad price.
async function visionExtractPrice(url, country, wantCur, fcKey, geminiKey) {
  // 1. screenshot via Firecrawl (rendered + stealth; Escape dismisses geo/locale modals)
  let shot = "";
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url, formats: ["screenshot"], proxy: "stealth", timeout: 60000,
        actions: [
          { type: "wait", milliseconds: 7000 },
          { type: "press", key: "Escape" },
          { type: "wait", milliseconds: 2000 },
          { type: "screenshot" },
        ],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    shot = d?.data?.screenshot || (d?.data?.actions?.screenshots || []).slice(-1)[0] || "";
    if (!shot) return null;
  } catch { return null; }

  // 2. fetch the image bytes → base64 for Gemini
  let b64, mime = "image/png";
  try {
    if (shot.startsWith("http")) {
      const ir = await fetch(shot);
      if (!ir.ok) return null;
      mime = ir.headers.get("content-type") || "image/png";
      const buf = await ir.arrayBuffer();
      b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    } else {
      b64 = shot.replace(/^data:image\/\w+;base64,/, "");
    }
  } catch { return null; }

  // 3. Gemini vision reads the displayed price. Strict: only the main product price, in wantCur.
  const prompt = [
    `This is a screenshot of an official brand product page for ${country}.`,
    `Read ONLY the main product's selling price as displayed on the page (ignore other items,`,
    `crossed-out/original prices, and "from" prices). The currency should be ${wantCur}.`,
    `Return ONLY JSON: { "price": <number, no symbols/separators>, "currency": "${wantCur}", "name": "<product name or null>" }.`,
    `If no clear single price is visible, return { "price": null, "currency": null }.`,
  ].join("\n");
  try {
    const gr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }) }
    );
    if (!gr.ok) return null;
    const gd = await gr.json();
    const text = (gd?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (parsed && typeof parsed.price === "number" && parsed.price > 0) {
      return { price: parsed.price, currency: parsed.currency || wantCur, name: parsed.name || null };
    }
    return null;
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (url.pathname === "/img") return handleImageProxy(url);
    if (url.pathname === "/debrand" && request.method === "POST") return handleDebrand(request, env);
    if (url.pathname === "/scrape" && request.method === "POST") return handleScrape(request, env, url);

    return json({ found: false, error: "Not found" }, 404);
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
      headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    return new Response("Proxy error: " + e.message, { status: 502, headers: CORS });
  }
}

async function handleDebrand(request, env) {
  let body;
  try { body = await request.json(); } catch {
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

async function getRates(base) {
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`);
    if (!r.ok) return null;
    const d = await r.json();
    const rates = (d && d.rates) ? d.rates : {};
    rates[base] = 1;
    rates.__date = (d && d.date) || null;
    for (const c of VALID_CURRENCIES) if (typeof rates[c] !== "number") return null;
    return rates;
  } catch {
    return null;
  }
}

function fallbackRates(base) {
  const r = { __date: null };
  for (const k of VALID_CURRENCIES) r[k] = FX_FALLBACK_USD[base] / FX_FALLBACK_USD[k];
  return r;
}
