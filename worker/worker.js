/* =============================================================================
   Cloudflare Worker — "Should You Buy It Here?" product lookup proxy
   -----------------------------------------------------------------------------
   Endpoints:
     GET  /img?url=<image url>  → Image proxy, bypasses hotlink protection
     POST /debrand              → AI logo removal
     POST /scrape               → Firecrawl + Gemini price scraper
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

/* ---------- Brand config ---------- */

const BLOCKED_DOMAINS = new Set([
  "farfetch.com","ssense.com","net-a-porter.com","mytheresa.com",
  "matchesfashion.com","nordstrom.com","saksfifthavenue.com",
  "bloomingdales.com","selfridges.com","harrods.com",
  "amazon.com","ebay.com","stockx.com","grailed.com","vestiairecollective.com",
]);

const BRAND_MAP = {
  "prada.com": {
    pathRegex: /\/(?:[a-z]{2})\/(?:[a-z]{2})\/(.*)/i,
    countries: {
      "United States":   "https://www.prada.com/us/en/{path}",
      "Canada":          "https://www.prada.com/ca/en/{path}",
      "France":          "https://www.prada.com/fr/fr/{path}",
      "Italy":           "https://www.prada.com/it/it/{path}",
      "United Kingdom":  "https://www.prada.com/gb/en/{path}",
      "Switzerland":     "https://www.prada.com/ch/en/{path}",
      "Japan":           "https://www.prada.com/jp/ja/{path}",
      "South Korea":     "https://www.prada.com/kr/ko/{path}",
    },
  },
  "louisvuitton.com": {
    pathRegex: /\/(?:[a-z]{2}-[a-z]{2})\/(.*)/i,
    countries: {
      "United States":   "https://us.louisvuitton.com/eng-us/{path}",
      "Canada":          "https://ca.louisvuitton.com/eng-ca/{path}",
      "France":          "https://fr.louisvuitton.com/fra-fr/{path}",
      "Italy":           "https://it.louisvuitton.com/ita-it/{path}",
      "United Kingdom":  "https://uk.louisvuitton.com/eng-gb/{path}",
      "Switzerland":     "https://ch.louisvuitton.com/eng-ch/{path}",
      "Japan":           "https://jp.louisvuitton.com/jpn-jp/{path}",
      "South Korea":     "https://kr.louisvuitton.com/kor-kr/{path}",
    },
  },
  "gucci.com": {
    pathRegex: /\/(?:[a-z]{2}-[a-z]{2})\/(.*)/i,
    countries: {
      "United States":   "https://www.gucci.com/us/en/{path}",
      "Canada":          "https://www.gucci.com/ca/en/{path}",
      "France":          "https://www.gucci.com/fr/fr/{path}",
      "Italy":           "https://www.gucci.com/it/it/{path}",
      "United Kingdom":  "https://www.gucci.com/uk/en/{path}",
      "Switzerland":     "https://www.gucci.com/ch/en/{path}",
      "Japan":           "https://www.gucci.com/jp/ja/{path}",
      "South Korea":     "https://www.gucci.com/kr/ko/{path}",
    },
  },
  "nike.com": {
    pathRegex: /\/(?:[a-z]+\/)?t\/(.*)/i,
    countries: {
      "United States":   "https://www.nike.com/t/{path}",
      "Canada":          "https://www.nike.com/ca/t/{path}",
      "France":          "https://www.nike.com/fr/t/{path}",
      "Italy":           "https://www.nike.com/it/t/{path}",
      "United Kingdom":  "https://www.nike.com/gb/t/{path}",
      "Switzerland":     "https://www.nike.com/ch/t/{path}",
      "Japan":           "https://www.nike.com/jp/t/{path}",
      "South Korea":     "https://www.nike.com/kr/t/{path}",
    },
  },
  "burberry.com": {
    pathRegex: /\/(?:[a-z]{2}-[a-z]{2})\/(.*)/i,
    countries: {
      "United States":   "https://us.burberry.com/en-us/{path}",
      "Canada":          "https://ca.burberry.com/en-ca/{path}",
      "France":          "https://fr.burberry.com/fr-fr/{path}",
      "Italy":           "https://it.burberry.com/it-it/{path}",
      "United Kingdom":  "https://uk.burberry.com/en-gb/{path}",
      "Switzerland":     "https://ch.burberry.com/en-ch/{path}",
      "Japan":           "https://jp.burberry.com/ja-jp/{path}",
      "South Korea":     "https://kr.burberry.com/ko-kr/{path}",
    },
  },
  "adidas.com": {
    pathRegex: /\/(?:[a-z]{2})\/(.*)/i,
    countries: {
      "United States":   "https://www.adidas.com/us/{path}",
      "Canada":          "https://www.adidas.ca/en/{path}",
      "France":          "https://www.adidas.fr/fr/{path}",
      "Italy":           "https://www.adidas.it/it/{path}",
      "United Kingdom":  "https://www.adidas.co.uk/en/{path}",
      "Switzerland":     "https://www.adidas.ch/en/{path}",
      "Japan":           "https://www.adidas.jp/ja/{path}",
      "South Korea":     "https://www.adidas.co.kr/ko/{path}",
    },
  },
};

/* ---------- Brand helpers ---------- */

function bareDomain(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

// Quick client-safe checks (no API call needed)
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

// Ask Gemini whether a URL belongs to an official brand website (not a reseller/marketplace).
async function validateOfficialSite(urlStr, geminiKey) {
  const pre = preValidateUrl(urlStr);
  if (!pre.valid) return { valid: false, reason: pre.reason };

  const prompt = [
    `Is this URL from an official brand website (the brand's own online store), or is it a third-party retailer/reseller/marketplace?`,
    `URL: ${urlStr}`,
    `Domain: ${pre.domain}`,
    `Return ONLY a JSON object: { "official": true/false, "brand": "BRAND NAME or null", "reason": "short explanation" }`,
  ].join("\n");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
        }),
      }
    );
    if (!res.ok) {
      // If Gemini is down, allow the request through (fail open)
      return { valid: true, domain: pre.domain };
    }
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (parsed && parsed.official === false) {
      return { valid: false, reason: parsed.reason || `"${pre.domain}" does not appear to be an official brand website` };
    }
    return { valid: true, domain: pre.domain, brand: parsed?.brand || null };
  } catch {
    // Network error — fail open
    return { valid: true, domain: pre.domain };
  }
}

function buildCountryUrls(inputUrl) {
  let parsed;
  try { parsed = new URL(inputUrl); } catch { return null; }
  const domain = bareDomain(parsed.hostname);
  const brand = BRAND_MAP[domain];
  if (!brand) return null;
  const m = parsed.pathname.match(brand.pathRegex);
  if (!m || !m[1]) return null;
  const productPath = m[1];
  const urls = {};
  for (const [country, template] of Object.entries(brand.countries)) {
    urls[country] = template.replace("{path}", productPath);
  }
  return urls;
}

/* ---------- Firecrawl + Gemini helpers ---------- */

async function firecrawlScrape(url, apiKey) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 5000,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `Firecrawl ${res.status}: ${t.slice(0, 200)}` };
    }
    const d = await res.json();
    if (!d.success) return { ok: false, error: d.error || "Firecrawl returned success=false" };
    return {
      ok: true,
      markdown: d.data?.markdown || "",
      metadata: d.data?.metadata || {},
    };
  } catch (e) {
    return { ok: false, error: "Firecrawl fetch error: " + e.message };
  }
}

function isProductPage(scrapeResult, originalUrl) {
  if (!scrapeResult.ok) return false;
  // Check if redirected to homepage (short path vs long source path)
  const finalUrl = scrapeResult.metadata?.sourceURL || scrapeResult.metadata?.url || "";
  if (finalUrl) {
    try {
      const orig = new URL(originalUrl);
      const final = new URL(finalUrl);
      const origSegments = orig.pathname.replace(/\/$/, "").split("/").filter(Boolean).length;
      const finalSegments = final.pathname.replace(/\/$/, "").split("/").filter(Boolean).length;
      if (origSegments >= 3 && finalSegments <= 1) return false; // redirected to homepage
    } catch { /* ignore parse errors */ }
  }
  // Check for price pattern in markdown
  const md = scrapeResult.markdown || "";
  const hasPrice = /(?:\$|€|£|¥|₩|CHF|USD|EUR|GBP|JPY|KRW)\s*[\d,.]+|[\d,.]+\s*(?:\$|€|£|¥|₩|CHF|USD|EUR|GBP|JPY|KRW)/i.test(md);
  return hasPrice;
}

async function geminiExtractProduct(markdown, mode, geminiKey, context) {
  const schema = mode === "full"
    ? `{ "name": "...", "brand": "...", "price": <number>, "currency": "XXX", "image_url": "...", "origin": "...", "category": "...", "blurb": "..." }`
    : `{ "price": <number>, "currency": "XXX" }`;

  const contextLine = context ? `\nContext: ${context}` : "";
  const prompt = [
    `Extract product information from this webpage markdown. Return ONLY a JSON object matching this schema:`,
    schema,
    `Rules: price must be a plain number (no symbols/separators). currency is the 3-letter ISO code.${contextLine}`,
    `If no product/price is found, return { "price": null, "currency": null }`,
    ``,
    `--- MARKDOWN ---`,
    markdown.slice(0, 15000),
  ].join("\n");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 },
        }),
      }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    return extractJson(text);
  } catch {
    return null;
  }
}

async function geminiSearchPrice(brand, productName, country, geminiKey) {
  const currency = CURRENCY_OF[country];
  const prompt = [
    `Find the current retail price of "${productName}" by ${brand} in ${country}.`,
    `Search the brand's official ${country} website or authorized retailers.`,
    `Return ONLY a JSON object: { "price": <number>, "currency": "${currency}", "found": true }`,
    `If you cannot find the price, return { "price": null, "currency": "${currency}", "found": false }`,
    `Price must be a plain number in ${currency}, no symbols or separators.`,
  ].join("\n");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 },
        }),
      }
    );
    if (!res.ok) return { price: null, currency, found: false };
    const d = await res.json();
    const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (parsed && typeof parsed.price === "number" && parsed.price > 0) {
      return { price: parsed.price, currency: parsed.currency || currency, found: true };
    }
    return { price: null, currency, found: false };
  } catch {
    return { price: null, currency, found: false };
  }
}

/* ---------- POST /scrape handler ---------- */

async function handleScrape(request, env, url) {
  let body;
  try { body = await request.json(); } catch {
    return json({ found: false, error: "Invalid JSON body" }, 400);
  }

  // Strip tracking params (utm_*, gclid, fbclid, etc.) — they confuse scraping & Gemini
  let inputUrl = (body.url || "").trim();
  try {
    const u = new URL(inputUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|gbraid|gclsrc|gad_|fbclid|mc_|ref$)/.test(key)) u.searchParams.delete(key);
    }
    inputUrl = u.toString();
  } catch { /* leave as-is if not a valid URL — validation will catch it */ }
  const homeCurrency = (body.homeCurrency || "USD").trim().toUpperCase();
  if (!inputUrl) return json({ found: false, error: "Missing 'url' in request body" }, 400);
  if (!VALID_CURRENCIES.includes(homeCurrency)) {
    return json({ found: false, error: `Invalid homeCurrency: ${homeCurrency}` }, 400);
  }

  const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
  const FIRECRAWL_KEY = env.FIRECRAWL_API_KEY || "";

  // Validate URL (blocklist check + Gemini official-site check)
  const validation = await validateOfficialSite(inputUrl, GEMINI_KEY);
  if (!validation.valid) {
    return json({ found: false, error: validation.reason }, 400);
  }

  // Step 1: Scrape the input URL to identify the product
  let product = null;
  let inputScrape = null;

  if (FIRECRAWL_KEY) {
    inputScrape = await firecrawlScrape(inputUrl, FIRECRAWL_KEY);
    if (inputScrape.ok && isProductPage(inputScrape, inputUrl)) {
      product = await geminiExtractProduct(inputScrape.markdown, "full", GEMINI_KEY, `Source URL: ${inputUrl}`);
    }
  }

  // Fallback: use Gemini + Google Search to identify the product from URL
  if (!product || !product.name) {
    const fallbackPrompt = [
      `Look at this product URL and identify the product: ${inputUrl}`,
      `Search the web to find full details about this product.`,
      `Return ONLY a JSON object:`,
      `{ "name": "full product name", "brand": "BRAND", "origin": "country of brand origin", "category": "short noun phrase", "blurb": "one sentence about the product", "image_url": "direct https image URL" }`,
    ].join("\n");

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0, maxOutputTokens: 2048 },
          }),
        }
      );
      if (res.ok) {
        const d = await res.json();
        const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
        const parsed = extractJson(text);
        if (parsed && parsed.name) {
          product = { ...product, ...parsed };
        }
      }
    } catch { /* continue without product info */ }
  }

  if (!product || !product.name) {
    return json({ found: false, error: "Could not identify the product from the given URL" }, 200);
  }

  // Step 2: Build country URLs
  const countryUrls = buildCountryUrls(inputUrl);

  // Step 3: Fetch prices for each of the 8 countries in parallel
  const ratesPromise = getRates(homeCurrency);

  const priceResults = await Promise.all(
    COUNTRIES.map(async (country) => {
      const currency = CURRENCY_OF[country];
      let price = null;
      let priceCurrency = currency;

      // Try Firecrawl on country-specific URL first
      if (FIRECRAWL_KEY && countryUrls && countryUrls[country]) {
        const scrape = await firecrawlScrape(countryUrls[country], FIRECRAWL_KEY);
        if (scrape.ok && isProductPage(scrape, countryUrls[country])) {
          const extracted = await geminiExtractProduct(
            scrape.markdown, "price", GEMINI_KEY,
            `Product: ${product.name} by ${product.brand}. Country: ${country}. Expected currency: ${currency}`
          );
          if (extracted && typeof extracted.price === "number" && extracted.price > 0) {
            price = extracted.price;
            priceCurrency = extracted.currency || currency;
          }
        }
      }

      // Fallback: Gemini + Google Search
      if (price === null) {
        const searchResult = await geminiSearchPrice(product.brand, product.name, country, GEMINI_KEY);
        if (searchResult.found) {
          price = searchResult.price;
          priceCurrency = searchResult.currency || currency;
        }
      }

      return { country, price, currency: priceCurrency };
    })
  );

  // Step 4: Assemble price maps
  const prices = {};
  const localPrices = {};
  for (const r of priceResults) {
    if (r.price !== null) {
      prices[r.country] = { price: r.price, currency: r.currency, available: true };
      localPrices[r.country] = r.price;
    } else {
      prices[r.country] = { available: false, reason: "Price not found" };
    }
  }

  // Step 5: Convert to home currency
  const rates = (await ratesPromise) || fallbackRates(homeCurrency);
  const homePrices = {};
  for (const [country, p] of Object.entries(prices)) {
    if (p.available) {
      const rate = rates[p.currency];
      if (typeof rate === "number" && rate > 0) {
        homePrices[country] = Math.round(p.price / rate);
      }
    }
  }

  // Step 6: Generate macro insight
  let macroInsight = "";
  try {
    const cheapest = Object.entries(homePrices).sort((a, b) => a[1] - b[1])[0];
    const expensive = Object.entries(homePrices).sort((a, b) => b[1] - a[1])[0];
    const insightPrompt = [
      `Product: ${product.name} by ${product.brand} (origin: ${product.origin || "unknown"}).`,
      `Prices converted to ${homeCurrency}: ${JSON.stringify(homePrices)}.`,
      `Cheapest: ${cheapest?.[0]}. Most expensive: ${expensive?.[0]}.`,
      `Write ONE concise sentence (max 35 words) tying this to ONE AP Macroeconomics concept:`,
      `exchange rates / currency depreciation, purchasing power parity, tariffs & VAT, net exports / shopping tourism, or home-country origin advantage.`,
      `Be specific about which country is cheapest and WHY. Return ONLY the sentence, no JSON.`,
    ].join(" ");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: insightPrompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 256 },
        }),
      }
    );
    if (res.ok) {
      const d = await res.json();
      macroInsight = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    }
  } catch { /* insight is optional */ }

  // Proxy product image
  const rawImg = cleanImageUrl(product.image_url);
  const proxyImg = rawImg ? `${url.origin}/img?url=${encodeURIComponent(rawImg)}` : "";

  return json({
    found: true,
    product: {
      name: str(product.name),
      brand: (str(product.brand) || "").toUpperCase() || "UNKNOWN BRAND",
      origin: str(product.origin) || "unknown",
      category: str(product.category) || "product",
      image_url: proxyImg,
      blurb: str(product.blurb) || "",
    },
    prices,
    local_prices: localPrices,
    home_prices: homePrices,
    home_currency: homeCurrency,
    fx_date: rates.__date || null,
    macro_insight: macroInsight,
  }, 200);
}

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

    // Product scraping endpoint
    if (url.pathname === "/scrape" && request.method === "POST") {
      return handleScrape(request, env, url);
    }

    return json({ error: "Not found. Use POST /scrape, GET /img, or POST /debrand." }, 404);
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
