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
const COUNTRY_ISO = {
  "United States":"US","Canada":"CA","France":"FR","Italy":"IT",
  "United Kingdom":"GB","Switzerland":"CH","Japan":"JP","South Korea":"KR"
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
          generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!res.ok) return { valid: true, domain: pre.domain };
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (parsed && parsed.official === false) {
      return { valid: false, reason: parsed.reason || `"${pre.domain}" does not appear to be an official brand website` };
    }
    return { valid: true, domain: pre.domain, brand: parsed?.brand || null };
  } catch {
    return { valid: true, domain: pre.domain };
  }
}

/* ---------- Dynamic site filter (no hardcoded brand map) ---------- */

const COUNTRY_LOCALE = {
  "United States": { codes: ["us"], langs: ["en","eng"] },
  "Canada":        { codes: ["ca"], langs: ["en","eng"] },
  "France":        { codes: ["fr"], langs: ["fr","fra"] },
  "Italy":         { codes: ["it"], langs: ["it","ita"] },
  "United Kingdom": { codes: ["gb","uk"], langs: ["en","eng"] },
  "Switzerland":   { codes: ["ch"], langs: ["en","de","fr"] },
  "Japan":         { codes: ["jp"], langs: ["ja","jpn"] },
  "South Korea":   { codes: ["kr"], langs: ["ko","kor"] },
};

function buildSiteFilter(inputUrl, country) {
  let parsed;
  try { parsed = new URL(inputUrl); } catch { return ""; }
  const hostname = parsed.hostname;
  const domain = bareDomain(hostname);
  const pathname = parsed.pathname;
  const locale = COUNTRY_LOCALE[country];
  if (!locale) return `site:${domain}`;
  const code = locale.codes[0];
  const lang = locale.langs[0];

  // Pattern 1: subdomain — us.louisvuitton.com → jp.louisvuitton.com
  const subMatch = hostname.match(/^([a-z]{2})\./);
  if (subMatch) {
    return `site:${code}.${domain}`;
  }

  // Pattern 2: /en-us/ → /ja-jp/ (balenciaga, burberry, margiela)
  const langCountry = pathname.match(/\/([a-z]{2,3})-([a-z]{2})\//);
  if (langCountry) {
    return `site:${domain}/${lang}-${code}`;
  }

  // Pattern 3: /us/en/ → /jp/ja/ (prada, gucci)
  const countryLang = pathname.match(/\/([a-z]{2})\/([a-z]{2})\//);
  if (countryLang) {
    return `site:${domain}/${code}`;
  }

  // Fallback: just use the domain
  return `site:${domain}`;
}

/* ---------- Price extraction (regex — no AI needed) ---------- */

function extractPriceFromText(text, expectedCurrency) {
  if (!text) return [];
  const prices = [];
  // Currency-specific patterns
  const patterns = {
    USD: /\$\s*([\d,]+(?:\.\d{2})?)/g,
    EUR: /€\s*([\d.,]+)/g,
    GBP: /£\s*([\d,]+(?:\.\d{2})?)/g,
    JPY: /[¥￥]\s*([\d,]+)/g,
    KRW: /₩\s*([\d,]+)/g,
    CHF: /CHF\s*([\d',]+(?:\.\d{2})?)/g,
    CAD: /CA\$\s*([\d,]+(?:\.\d{2})?)/g,
  };

  const pat = patterns[expectedCurrency];
  if (pat) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const raw = (m[1] || "").replace(/[',\s]/g, "");
      let num;
      // European: 3.500 = 3500 (3 digits after dot), 3.50 = 3.50
      if (raw.includes(".") && raw.split(".").pop().length === 3) {
        num = parseFloat(raw.replace(/\./g, ""));
      } else {
        num = parseFloat(raw.replace(/,/g, ""));
      }
      if (!isNaN(num) && num > 0) prices.push(num);
    }
  }
  return prices;
}

function pickBestPrice(prices, currency) {
  if (!prices.length) return null;
  // Count occurrences of each price
  const counts = {};
  for (const p of prices) { counts[p] = (counts[p] || 0) + 1; }
  // Sort by frequency (desc), then value (asc)
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || parseFloat(a[0]) - parseFloat(b[0]));
  const best = parseFloat(sorted[0][0]);

  // Sanity check: convert to USD equivalent
  const usdEquiv = best * (FX_FALLBACK_USD[currency] || 1);
  if (usdEquiv >= 30 && usdEquiv <= 200000) return best;
  return null;
}

/* ---------- Firecrawl Search ---------- */

async function firecrawlSearchPrice(brand, productName, country, siteFilter, apiKey, geminiKey) {
  const currency = CURRENCY_OF[country];
  try {
    const query = `${brand} ${productName} price ${siteFilter}`;
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, limit: 5 }),
    });
    if (!res.ok) return { price: null, currency, found: false };
    const d = await res.json();
    if (!d.success || !d.data || !d.data.length) return { price: null, currency, found: false };

    // Step 1: Regex extraction (fast, reliable, no AI)
    const allContent = d.data.map(r => `${r.title || ""} ${r.markdown || r.description || ""}`).join(" ");
    const regexPrices = extractPriceFromText(allContent, currency);
    const bestPrice = pickBestPrice(regexPrices, currency);
    if (bestPrice !== null) {
      return { price: bestPrice, currency, found: true };
    }

    // Step 2: Gemini extraction only if regex failed
    const snippets = d.data.map(r => {
      const content = r.markdown || r.description || "";
      return `Title: ${r.title || ""}\nContent: ${content.slice(0, 500)}`;
    }).join("\n---\n");

    const prompt = [
      `From these search results, find the retail price of "${productName}" by ${brand}.`,
      `The price should be in ${currency}. Match the exact product (size matters: small ≠ mini ≠ micro).`,
      `Return ONLY: { "price": <number>, "currency": "${currency}", "found": true }`,
      `Price = plain number, no symbols. If unsure, return { "price": null, "currency": "${currency}", "found": false }`,
      `\n--- SEARCH RESULTS ---\n${snippets.slice(0, 6000)}`,
    ].join("\n");

    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!gemRes.ok) return { price: null, currency, found: false };
    const gemData = await gemRes.json();
    const text = (gemData?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (parsed && typeof parsed.price === "number" && parsed.price > 0 && parsed.found) {
      return { price: parsed.price, currency: parsed.currency || currency, found: true };
    }
    return { price: null, currency, found: false };
  } catch {
    return { price: null, currency, found: false };
  }
}

/* ---------- Gemini helpers ---------- */

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
          generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
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

// Gemini batch search — one call for all missing countries
async function geminiBatchSearchPrices(brand, productName, missingCountries, geminiKey) {
  if (!missingCountries.length) return {};
  const countryList = missingCountries.map(c => `${c} (currency: ${CURRENCY_OF[c]})`).join(", ");
  const prompt = [
    `Find the current official retail price of "${productName}" by ${brand} in each of these countries: ${countryList}.`,
    `Search the brand's official website for each country. Luxury brands set DIFFERENT prices per region — do NOT use the same price for all countries.`,
    `Return ONLY a JSON object with this structure:`,
    `{`,
    ...missingCountries.map(c => `  "${c}": { "price": <number in ${CURRENCY_OF[c]}>, "found": true/false },`),
    `}`,
    `Rules:`,
    `- Each price must be in that country's LOCAL currency (not converted)`,
    `- Price must be a plain number (no symbols, no thousands separators)`,
    `- If you cannot find a price for a country, set "price": null and "found": false`,
    `- Do NOT guess or estimate — only report prices you actually find on official brand websites`,
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
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
        }),
      }
    );
    if (!res.ok) return {};
    const d = await res.json();
    const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const parsed = extractJson(text);
    if (!parsed) return {};

    const results = {};
    for (const country of missingCountries) {
      const entry = parsed[country];
      if (entry && typeof entry.price === "number" && entry.price > 0 && entry.found) {
        results[country] = { price: entry.price, currency: CURRENCY_OF[country], found: true };
      }
    }
    return results;
  } catch {
    return {};
  }
}

/* ---------- POST /scrape handler ---------- */

async function handleScrape(request, env, url) {
  let body;
  try { body = await request.json(); } catch {
    return json({ found: false, error: "Invalid JSON body" }, 400);
  }

  // Strip tracking params
  let inputUrl = (body.url || "").trim();
  try {
    const u = new URL(inputUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|gbraid|gclsrc|gad_|fbclid|mc_|ref$|srsltid)/.test(key)) u.searchParams.delete(key);
    }
    inputUrl = u.toString();
  } catch { /* leave as-is */ }
  const homeCurrency = (body.homeCurrency || "USD").trim().toUpperCase();
  if (!inputUrl) return json({ found: false, error: "Missing 'url' in request body" }, 400);
  if (!VALID_CURRENCIES.includes(homeCurrency)) {
    return json({ found: false, error: `Invalid homeCurrency: ${homeCurrency}` }, 400);
  }

  const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
  const FIRECRAWL_KEY = env.FIRECRAWL_API_KEY || "";

  // Validate URL
  const validation = await validateOfficialSite(inputUrl, GEMINI_KEY);
  if (!validation.valid) {
    return json({ found: false, error: validation.reason }, 400);
  }

  // Step 1: Identify the product using Firecrawl Search + Gemini
  let product = null;

  if (FIRECRAWL_KEY) {
    try {
      const searchRes = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FIRECRAWL_KEY}`,
        },
        body: JSON.stringify({ query: inputUrl, limit: 3 }),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.success && searchData.data && searchData.data.length > 0) {
          const snippets = searchData.data.map(r => {
            const content = r.markdown || r.description || "";
            return `Title: ${r.title || ""}\nURL: ${r.url || ""}\nContent: ${content.slice(0, 800)}`;
          }).join("\n---\n");

          const idPrompt = [
            `From these search results, identify the product at this URL: ${inputUrl}`,
            `Return ONLY a JSON object:`,
            `{ "name": "full product name (include size if applicable)", "brand": "BRAND", "origin": "country of brand origin", "category": "short noun phrase", "blurb": "one sentence about the product", "image_url": "direct https image URL or null" }`,
            ``,
            `--- SEARCH RESULTS ---`,
            snippets,
          ].join("\n");

          const gemRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: idPrompt }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
              }),
            }
          );
          if (gemRes.ok) {
            const gemData = await gemRes.json();
            const text = (gemData?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
            const parsed = extractJson(text);
            if (parsed && parsed.name) product = parsed;
          }
        }
      }
    } catch { /* continue to Gemini fallback */ }
  }

  // Fallback: Gemini + Google Search
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
    } catch { /* continue */ }
  }

  if (!product || !product.name) {
    return json({ found: false, error: "Could not identify the product from the given URL" }, 200);
  }

  // Step 2: Fetch prices
  const ratesPromise = getRates(homeCurrency);
  const priceResults = [];

  if (FIRECRAWL_KEY) {
    const batches = [];
    for (let i = 0; i < COUNTRIES.length; i += 4) {
      batches.push(COUNTRIES.slice(i, i + 4));
    }
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (country) => {
          const currency = CURRENCY_OF[country];
          try {
            const siteFilter = buildSiteFilter(inputUrl, country);
            const result = await firecrawlSearchPrice(
              product.brand, product.name, country, siteFilter, FIRECRAWL_KEY, GEMINI_KEY
            );
            if (result.found) {
              return { country, price: result.price, currency: result.currency || currency, source: "firecrawl-search" };
            }
          } catch { /* continue */ }
          return { country, price: null, currency };
        })
      );
      priceResults.push(...batchResults);
    }
  } else {
    for (const country of COUNTRIES) {
      priceResults.push({ country, price: null, currency: CURRENCY_OF[country] });
    }
  }

  // Tier 2: Gemini batch for missing countries
  const missingCountries = priceResults.filter(r => r.price === null).map(r => r.country);
  if (missingCountries.length > 0) {
    const batchResults = await geminiBatchSearchPrices(product.brand, product.name, missingCountries, GEMINI_KEY);
    for (const country of missingCountries) {
      const br = batchResults[country];
      if (br && br.found) {
        const idx = priceResults.findIndex(r => r.country === country);
        if (idx !== -1) {
          priceResults[idx] = { country, price: br.price, currency: br.currency, source: "gemini-search" };
        }
      }
    }
  }

  // Step 3: Assemble price maps
  const prices = {};
  const localPrices = {};
  for (const r of priceResults) {
    if (r.price !== null) {
      prices[r.country] = { price: r.price, currency: r.currency, available: true, source: r.source || "unknown" };
      localPrices[r.country] = r.price;
    } else {
      prices[r.country] = { available: false, reason: "Price not found" };
    }
  }

  // Step 4: Convert to home currency
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

  // Step 5: Generate macro insight
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
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
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

    if (url.pathname === "/img") return handleImageProxy(url);
    if (url.pathname === "/debrand" && request.method === "POST") return handleDebrand(request, env);
    if (url.pathname === "/scrape" && request.method === "POST") return handleScrape(request, env, url);

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
