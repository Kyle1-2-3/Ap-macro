# URL-Based International Price Comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace photo-upload + name-input flow with URL input. System extracts product info from official brand URLs and compares prices across 8 countries.

**Architecture:** Frontend validates URL against whitelist/blacklist, sends to Worker. Worker extracts brand + SKU from URL, tries Firecrawl scrape (works for Nike-like sites), falls back to Gemini + Google Search grounding for luxury brands that block scraping (Prada, LV, Gucci). Results include per-country prices or "unavailable" markers. Existing debranding flow reuses scraped product image.

**Tech Stack:** Cloudflare Worker (existing), Firecrawl REST API, Gemini 2.5 Flash (existing), ECB exchange rates (existing), vanilla HTML/CSS/JS frontend (existing)

**Key finding from testing:** Most luxury brands (Prada, LV, Gucci, Burberry) actively block Firecrawl. Nike works. The plan uses Firecrawl-first with Gemini fallback.

---

## File Structure

| File | Role | Action |
|------|------|--------|
| `worker/worker.js` | Backend — all endpoints | Modify: add `/scrape`, remove `GET /?q=`, add Firecrawl+Gemini hybrid logic |
| `index.html` | Frontend — full app | Modify: replace upload+name UI with URL input, update results rendering for unavailable countries |

Only 2 files change. The worker stays as a single file (matches existing pattern). The frontend stays as a single HTML file with inline CSS/JS (matches existing pattern).

---

### Task 1: Add brand config data to Worker

**Files:**
- Modify: `worker/worker.js:1-18`

Add the whitelist, blacklist, brand URL mapping table, and SKU extraction patterns.

- [ ] **Step 1: Add brand config constants after existing COUNTRIES/CURRENCY constants**

```js
// --- Brand validation ---
const OFFICIAL_DOMAINS = new Set([
  "prada.com","louisvuitton.com","gucci.com","chanel.com","hermes.com",
  "dior.com","balenciaga.com","bottegaveneta.com","saintlaurent.com","ysl.com",
  "burberry.com","fendi.com","loewe.com","celine.com","moncler.com",
  "cartier.com","tiffany.com","rolex.com","omega.com","tagheuer.com",
  "iwc.com","nike.com","adidas.com","newbalance.com"
]);

const BLOCKED_DOMAINS = new Set([
  "farfetch.com","ssense.com","net-a-porter.com","mytheresa.com",
  "matchesfashion.com","nordstrom.com","saksfifthavenue.com",
  "bloomingdales.com","selfridges.com","harrods.com","amazon.com",
  "ebay.com","stockx.com","grailed.com","vestiairecollective.com"
]);

// Brand URL mapping: how to build country-variant URLs.
// pathRegex extracts the product path from the input URL.
// countries maps country name -> URL template where {path} is replaced.
const BRAND_MAP = {
  "prada.com": {
    pathRegex: /^\/[a-z]{2}\/[a-z]{2}\/(.+)$/,
    countries: {
      "United States": "/us/en/{path}",
      "Canada": "/ca/en/{path}",
      "France": "/fr/fr/{path}",
      "Italy": "/it/it/{path}",
      "United Kingdom": "/gb/en/{path}",
      "Switzerland": "/ch/en/{path}",
      "Japan": "/jp/ja/{path}",
      "South Korea": "/kr/ko/{path}"
    }
  },
  "louisvuitton.com": {
    pathRegex: /^\/[a-z]{2,3}-[a-z]{2}\/products\/(.+)$/,
    countries: {
      "United States": "/eng-us/products/{path}",
      "Canada": "/eng-ca/products/{path}",
      "France": "/fra-fr/products/{path}",
      "Italy": "/ita-it/products/{path}",
      "United Kingdom": "/eng-gb/products/{path}",
      "Switzerland": "/deu-ch/products/{path}",
      "Japan": "/jpn-jp/products/{path}",
      "South Korea": "/kor-kr/products/{path}"
    }
  },
  "gucci.com": {
    pathRegex: /^\/[a-z]{2}\/en\/pr\/(.+)$/,
    countries: {
      "United States": "/us/en/pr/{path}",
      "Canada": "/ca/en/pr/{path}",
      "France": "/fr/fr/pr/{path}",
      "Italy": "/it/it/pr/{path}",
      "United Kingdom": "/gb/en/pr/{path}",
      "Switzerland": "/ch/en/pr/{path}",
      "Japan": "/jp/ja/pr/{path}",
      "South Korea": "/kr/ko/pr/{path}"
    }
  },
  "nike.com": {
    pathRegex: /^\/t\/(.+)$/,
    countries: {
      "United States": "/t/{path}",
      "Canada": "/ca/t/{path}",
      "France": "/fr/t/{path}",
      "Italy": "/it/t/{path}",
      "United Kingdom": "/gb/t/{path}",
      "Switzerland": "/ch/t/{path}",
      "Japan": "/jp/t/{path}",
      "South Korea": "/kr/t/{path}"
    },
    baseDomains: {
      "United States": "www.nike.com",
      "Canada": "www.nike.com",
      "France": "www.nike.com",
      "Italy": "www.nike.com",
      "United Kingdom": "www.nike.com",
      "Switzerland": "www.nike.com",
      "Japan": "www.nike.com",
      "South Korea": "www.nike.com"
    }
  },
  "burberry.com": {
    pathRegex: /^\/(.+-p\d+)$/,
    countries: {
      "United States": "/us/{path}",
      "Canada": "/ca/{path}",
      "France": "/fr/{path}",
      "Italy": "/it/{path}",
      "United Kingdom": "/gb/{path}",
      "Switzerland": "/ch/{path}",
      "Japan": "/jp/{path}",
      "South Korea": "/kr/{path}"
    }
  },
  "adidas.com": {
    pathRegex: /^\/[a-z]{2}\/(.+)$/,
    countries: {
      "United States": "/us/{path}",
      "Canada": "/ca/{path}",
      "France": "/fr/{path}",
      "Italy": "/it/{path}",
      "United Kingdom": "/gb/{path}",
      "Switzerland": "/ch/{path}",
      "Japan": "/jp/{path}",
      "South Korea": "/kr/{path}"
    }
  }
};

// Extract the "bare" domain from a hostname (strip www. prefix)
function bareDomain(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

// Validate a URL: returns { valid, domain, rejected, reason }
function validateBrandUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return { valid: false, reason: "Invalid URL" }; }
  if (parsed.protocol !== "https:") return { valid: false, reason: "URL must use HTTPS" };
  const domain = bareDomain(parsed.hostname);
  if (BLOCKED_DOMAINS.has(domain)) return { valid: false, rejected: true, domain, reason: `Third-party retailer "${domain}" is not supported. Use the brand's official website.` };
  if (!OFFICIAL_DOMAINS.has(domain)) return { valid: false, rejected: true, domain, reason: `"${domain}" is not a recognized official brand website.` };
  return { valid: true, domain, parsed };
}

// Build country URLs from a known brand mapping. Returns { country: url } or null if brand not mapped.
function buildCountryUrls(inputUrl) {
  const parsed = new URL(inputUrl);
  const domain = bareDomain(parsed.hostname);
  const mapping = BRAND_MAP[domain];
  if (!mapping) return null;

  const match = parsed.pathname.match(mapping.pathRegex);
  if (!match) return null;
  const productPath = match[1];

  const urls = {};
  for (const [country, template] of Object.entries(mapping.countries)) {
    const path = template.replace("{path}", productPath);
    const host = (mapping.baseDomains && mapping.baseDomains[country]) || parsed.hostname;
    urls[country] = `https://${host}${path}`;
  }
  return urls;
}
```

- [ ] **Step 2: Verify the config compiles (no syntax errors)**

Run: `cd /Users/kyle/Ap-macro/worker && node -c worker.js`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /Users/kyle/Ap-macro
git add worker/worker.js
git commit -m "feat(worker): add brand whitelist, blacklist, and URL mapping config"
```

---

### Task 2: Add Firecrawl scraping + Gemini extraction helpers to Worker

**Files:**
- Modify: `worker/worker.js` (add functions before the `export default` block)

These are the core helpers: call Firecrawl API, detect if scrape got real product data or a redirect/homepage, and call Gemini to extract structured product info from markdown.

- [ ] **Step 1: Add Firecrawl scrape helper**

```js
// Call Firecrawl REST API to scrape a URL. Returns { ok, markdown, metadata } or { ok:false, error }.
async function firecrawlScrape(url, apiKey) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor: 5000 }),
    });
    if (!res.ok) return { ok: false, error: `Firecrawl HTTP ${res.status}` };
    const d = await res.json();
    if (!d.success) return { ok: false, error: d.error || "Firecrawl failed" };
    return { ok: true, markdown: d.data?.markdown || "", metadata: d.data?.metadata || {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Check if a Firecrawl result is a real product page (not a homepage/redirect/category).
// Heuristic: the final URL should still contain a product identifier, and the page should
// mention a price-like pattern (currency symbol + digits).
function isProductPage(scrapeResult, originalUrl) {
  if (!scrapeResult.ok) return false;
  const finalUrl = scrapeResult.metadata?.url || "";
  const sourceUrl = scrapeResult.metadata?.sourceURL || originalUrl;
  // If final URL is very different from source (redirected to homepage), it's not a product page
  if (finalUrl && sourceUrl) {
    const finalPath = new URL(finalUrl).pathname;
    const sourcePath = new URL(sourceUrl).pathname;
    // Homepage redirects typically have very short paths like /us/en.html or /
    if (finalPath.split("/").filter(Boolean).length <= 2 && sourcePath.split("/").filter(Boolean).length > 2) {
      return false;
    }
  }
  // Check for price indicators in the markdown
  const md = scrapeResult.markdown;
  const hasPricePattern = /[$£€¥₩]\s*[\d,.]+|[\d,.]+\s*(?:USD|EUR|GBP|JPY|KRW|CHF|CAD)/.test(md);
  return hasPricePattern;
}
```

- [ ] **Step 2: Add Gemini product extraction helper**

```js
// Use Gemini to extract product info from scraped markdown.
// mode: "full" (first scrape — extract everything) or "price" (country variant — just price)
async function geminiExtractProduct(markdown, mode, geminiKey, context) {
  const truncated = markdown.slice(0, 8000); // keep within token limits
  const prompt = mode === "full"
    ? [
        `Extract product information from this webpage content. Return ONLY a JSON object, no markdown fences.`,
        `{`,
        `  "product_name": "full product name",`,
        `  "brand": "BRAND NAME in uppercase",`,
        `  "price": <number, no currency symbol or commas>,`,
        `  "currency": "3-letter currency code (USD/EUR/GBP/CHF/JPY/KRW/CAD)",`,
        `  "image_url": "direct URL to product image (https, .jpg/.png/.webp)",`,
        `  "origin_country": "country where brand is headquartered",`,
        `  "category": "short noun phrase, e.g. handbag / sneakers / watch",`,
        `  "blurb": "one sentence about production cost vs retail price"`,
        `}`,
        `If you cannot find a price, set price to null.`,
        ``,
        `Webpage content:`,
        truncated
      ].join("\n")
    : [
        `Extract the product price from this webpage. The product is: ${context || "unknown"}.`,
        `Return ONLY a JSON object: { "price": <number>, "currency": "XXX" }`,
        `If the product is not on this page or has no price, return: { "price": null }`,
        ``,
        `Webpage content:`,
        truncated
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
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    return extractJson(text);
  } catch { return null; }
}

// Use Gemini + Google Search to look up a product's price on a specific country's official site.
// This is the fallback when Firecrawl can't scrape the page.
async function geminiSearchPrice(brand, productName, country, geminiKey) {
  const currency = CURRENCY_OF[country];
  const prompt = [
    `Use Google Search to find the current retail price of "${productName}" by ${brand} on the brand's official website for ${country}.`,
    `Search specifically on the official ${brand} website for ${country}.`,
    `Return ONLY a JSON object: { "price": <number in ${currency}>, "currency": "${currency}", "found": true }`,
    `If you cannot find it on the official site, return: { "price": null, "found": false }`,
    `Plain number only — no currency symbols, no commas.`,
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
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    return extractJson(text);
  } catch { return null; }
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/kyle/Ap-macro/worker && node -c worker.js`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd /Users/kyle/Ap-macro
git add worker/worker.js
git commit -m "feat(worker): add Firecrawl scrape + Gemini extraction helpers"
```

---

### Task 3: Add `/scrape` endpoint to Worker

**Files:**
- Modify: `worker/worker.js` — add route in `fetch()` handler, add `handleScrape` function

This is the main new endpoint. It orchestrates: validate URL → scrape input URL → extract product info → build country URLs → scrape all countries in parallel → assemble response.

- [ ] **Step 1: Add route in the fetch handler (after the `/debrand` route)**

```js
    // Product scrape endpoint (new — replaces GET /?q=)
    if (url.pathname === "/scrape" && request.method === "POST") {
      return handleScrape(request, env, url);
    }
```

- [ ] **Step 2: Add the handleScrape function**

```js
async function handleScrape(request, env, workerUrl) {
  let body;
  try { body = await request.json(); } catch { return json({ found: false, error: "Invalid JSON body" }, 400); }

  const { url: inputUrl, homeCurrency } = body;
  if (!inputUrl || typeof inputUrl !== "string") return json({ found: false, error: "Missing 'url'" }, 400);

  // Validate the URL
  const validation = validateBrandUrl(inputUrl);
  if (!validation.valid) return json({ found: false, error: validation.reason, rejected: !!validation.rejected }, 400);

  const GEMINI_KEY = env.GEMINI_API_KEY || API_KEY_FALLBACK;
  const FIRECRAWL_KEY = env.FIRECRAWL_API_KEY || "";

  let displayCur = (homeCurrency || "USD").trim().toUpperCase();
  if (!VALID_CURRENCIES.includes(displayCur)) displayCur = "USD";

  // Step 1: Scrape the input URL to get product info
  let product = null;
  let inputPrice = null;
  let inputCurrency = null;
  let inputCountryFromUrl = null;

  const scrapeResult = FIRECRAWL_KEY ? await firecrawlScrape(inputUrl, FIRECRAWL_KEY) : { ok: false };

  if (isProductPage(scrapeResult, inputUrl)) {
    // Firecrawl got a real product page — extract structured data
    const extracted = await geminiExtractProduct(scrapeResult.markdown, "full", GEMINI_KEY);
    if (extracted && extracted.product_name) {
      product = {
        name: extracted.product_name,
        brand: (extracted.brand || "").toUpperCase(),
        origin: extracted.origin_country || "unknown",
        category: extracted.category || "product",
        image_url: cleanImageUrl(extracted.image_url),
        blurb: extracted.blurb || "",
      };
      inputPrice = extracted.price;
      inputCurrency = extracted.currency;
    }
  }

  // Firecrawl failed or didn't get product data — fall back to Gemini search
  if (!product) {
    // Try to extract brand name and SKU from the URL pattern
    const parsed = new URL(inputUrl);
    const domain = bareDomain(parsed.hostname);
    const brandGuess = domain.replace(/\.com$/, "").replace(/\./g, " ");

    const fallbackPrompt = [
      `Use Google Search to find information about the product at this URL: ${inputUrl}`,
      `The brand is likely "${brandGuess}". Find the product name, price, and details.`,
      `Return ONLY a JSON object:`,
      `{`,
      `  "product_name": "full product name",`,
      `  "brand": "BRAND NAME",`,
      `  "price": <number in local currency, no symbols>,`,
      `  "currency": "3-letter code",`,
      `  "image_url": "direct product image URL",`,
      `  "origin_country": "brand HQ country",`,
      `  "category": "short noun phrase",`,
      `  "blurb": "one sentence about the product"`,
      `}`,
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
            generationConfig: { temperature: 0, maxOutputTokens: 4096 },
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
        const extracted = extractJson(text);
        if (extracted && extracted.product_name) {
          product = {
            name: extracted.product_name,
            brand: (extracted.brand || "").toUpperCase(),
            origin: extracted.origin_country || "unknown",
            category: extracted.category || "product",
            image_url: cleanImageUrl(extracted.image_url),
            blurb: extracted.blurb || "",
          };
          inputPrice = extracted.price;
          inputCurrency = extracted.currency;
        }
      }
    } catch {}
  }

  if (!product) return json({ found: false, error: "Could not identify the product from this URL" }, 200);

  // Step 2: Build country variant URLs and scrape them all in parallel
  const countryUrls = buildCountryUrls(inputUrl);
  const ratesPromise = getRates(displayCur);

  // Determine which country the input URL belongs to (for dedup)
  // Try to detect from URL pattern
  const inputParsed = new URL(inputUrl);
  const domain = bareDomain(inputParsed.hostname);
  const mapping = BRAND_MAP[domain];

  const prices = {};   // country -> { price, currency, available, reason, url }

  // Scrape all 8 countries in parallel
  const countryPromises = COUNTRIES.map(async (country) => {
    const countryUrl = countryUrls ? countryUrls[country] : null;

    // Try Firecrawl first if we have a URL and a key
    if (countryUrl && FIRECRAWL_KEY) {
      const scrape = await firecrawlScrape(countryUrl, FIRECRAWL_KEY);
      if (isProductPage(scrape, countryUrl)) {
        const data = await geminiExtractProduct(scrape.markdown, "price", GEMINI_KEY, product.name);
        if (data && data.price && typeof data.price === "number") {
          return { country, price: data.price, currency: data.currency || CURRENCY_OF[country], available: true, url: countryUrl };
        }
      }
    }

    // Firecrawl failed or no URL — fall back to Gemini search
    const searchResult = await geminiSearchPrice(product.brand, product.name, country, GEMINI_KEY);
    if (searchResult && searchResult.found && searchResult.price && typeof searchResult.price === "number") {
      return { country, price: searchResult.price, currency: searchResult.currency || CURRENCY_OF[country], available: true, url: countryUrl };
    }

    // Not found
    return { country, available: false, reason: `Product not listed on ${product.brand.toLowerCase()}.com ${country}`, url: countryUrl };
  });

  const results = await Promise.all(countryPromises);

  // Assemble prices map
  for (const r of results) {
    if (r.available) {
      prices[r.country] = { price: r.price, currency: r.currency, available: true, url: r.url };
    } else {
      prices[r.country] = { available: false, reason: r.reason };
    }
  }

  // Convert to home currency using live rates
  const rates = (await ratesPromise) || fallbackRates(displayCur);
  const homePrices = {};
  const localPrices = {};
  for (const [country, info] of Object.entries(prices)) {
    if (!info.available) continue;
    localPrices[country] = info.price;
    const rate = rates[info.currency];
    if (typeof rate === "number" && rate > 0) {
      homePrices[country] = Math.round(info.price / rate);
    }
  }

  // Generate macro insight
  const availableCountries = Object.entries(prices).filter(([,v]) => v.available).length;
  let macroInsight = "";
  if (availableCountries >= 2) {
    const sorted = Object.entries(homePrices).sort((a,b) => a[1] - b[1]);
    const cheapest = sorted[0];
    const dearest = sorted[sorted.length - 1];
    macroInsight = `${cheapest[0]} offers the lowest price — regional pricing, local taxes, and exchange rates create a ${Math.round((dearest[1] - cheapest[1]) / dearest[1] * 100)}% spread across markets.`;
  }

  // Proxy the product image
  const proxyImg = product.image_url ? `${workerUrl.origin}/img?url=${encodeURIComponent(product.image_url)}` : "";

  return json({
    found: availableCountries >= 1,
    product: {
      name: product.name,
      brand: product.brand,
      origin: product.origin,
      category: product.category,
      image_url: proxyImg,
      blurb: product.blurb,
    },
    prices,
    local_prices: localPrices,
    home_prices: homePrices,
    home_currency: displayCur,
    fx_date: rates.__date || null,
    macro_insight: macroInsight,
  }, 200);
}
```

- [ ] **Step 3: Remove the old `GET /?q=` product lookup route**

Delete the block in the `fetch()` handler that handles `q` param (lines ~36-97 in current worker.js), and delete the old `buildPrompt` function. Keep `extractJson`, `str`, `cleanImageUrl`, `json`, `getRates`, `fallbackRates`, `handleImageProxy`, `handleDebrand`.

- [ ] **Step 4: Verify syntax**

Run: `cd /Users/kyle/Ap-macro/worker && node -c worker.js`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
cd /Users/kyle/Ap-macro
git add worker/worker.js
git commit -m "feat(worker): add POST /scrape endpoint, remove old GET /?q= lookup"
```

---

### Task 4: Add FIRECRAWL_API_KEY as Worker secret

**Files:**
- Modify: `worker/wrangler.toml` (no code change, just deploy command)

- [ ] **Step 1: Add the secret via wrangler CLI**

Run: `cd /Users/kyle/Ap-macro/worker && npx wrangler secret put FIRECRAWL_API_KEY`

When prompted, paste: `fc-4d7553435dc44c599623dfc09689c723`

- [ ] **Step 2: Deploy the worker**

Run: `cd /Users/kyle/Ap-macro/worker && npx wrangler deploy`
Expected: successful deployment

- [ ] **Step 3: Test the /scrape endpoint**

Run:
```bash
curl -s -X POST "https://ap-macro-lookup.bridge11korea.workers.dev/scrape" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.nike.com/t/air-force-1-07-mens-shoes-jBrhbr/CW2288-111","homeCurrency":"USD"}' | python3 -m json.tool | head -40
```

Expected: JSON with `found: true`, product name, prices for multiple countries

- [ ] **Step 4: Test with a luxury brand (Prada) — should fall back to Gemini**

Run:
```bash
curl -s -X POST "https://ap-macro-lookup.bridge11korea.workers.dev/scrape" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.prada.com/us/en/women/accessories/card-holders-and-coin-purses/products.1MR034_2HIM_F0G3N.html","homeCurrency":"USD"}' | python3 -m json.tool | head -40
```

Expected: JSON with product info (via Gemini fallback), some countries available, some potentially unavailable

- [ ] **Step 5: Commit (if wrangler.toml changed)**

```bash
cd /Users/kyle/Ap-macro
git add worker/
git commit -m "chore(worker): deploy with FIRECRAWL_API_KEY secret"
```

---

### Task 5: Replace frontend input UI (URL input replaces upload + name)

**Files:**
- Modify: `index.html` — the `#search` section HTML and related CSS

Replace the upload zone + product name input with a single URL input field. Update i18n strings.

- [ ] **Step 1: Replace the search section HTML**

Find the `<!-- SEARCH / UPLOAD -->` section (around line 290-340 in the current HTML). Replace the upload zone and product name input with:

```html
  <!-- SEARCH / URL INPUT -->
  <section id="search">
    <div class="wrap">
      <div class="sec-head">
        <span class="overline" data-i18n="prodOverline">02 — The Product</span>
        <h2 data-i18n="prodH2">Paste a product URL</h2>
        <p class="prose" data-i18n="prodP">Paste the URL of any product from an official brand website. We'll scrape the name, photo, and price — then compare it across 8 countries.</p>
      </div>

      <div style="max-width:680px">
        <div class="search-field">
          <input id="q" type="url" data-i18n-ph="qPh" placeholder="e.g. https://www.prada.com/us/en/women/bags/..." autocomplete="off">
          <button id="goBtn" data-i18n="goBtn">Compare Prices</button>
        </div>
        <div class="search-msg" id="searchMsg"></div>
      </div>
    </div>
  </section>
```

- [ ] **Step 2: Remove upload-related CSS**

Delete these CSS blocks: `.upload-zone`, `.upload-zone:hover`, `.upload-zone.dragover`, `.upload-zone input[type=file]`, `.upload-zone .uz-icon`, `.upload-zone .uz-text`, `.upload-zone .uz-sub`, `.upload-preview`, `.upload-preview img`, `.upload-preview .up-actions`.

- [ ] **Step 3: Add CSS for unavailable table rows**

Add to the `<style>` section:

```css
  tbody tr.unavailable td{color:var(--body);font-style:italic}
  tbody tr.unavailable td.num{font-family:var(--sans);font-size:13px;font-weight:400;color:var(--body)}
```

- [ ] **Step 4: Update i18n strings in the STR object**

Replace relevant entries:

```js
  prodH2:{en:"Paste a product URL", ja:"商品URLを貼り付ける"},
  prodP:{en:`Paste the URL of any product from an official brand website. We'll scrape the name, photo, and price — then compare it across 8 countries.`, ja:`公式ブランドサイトの商品URLを貼り付けてください。商品名・写真・価格を自動で取得し、8か国で比較します。`},
  qPh:{en:"e.g. https://www.prada.com/us/en/women/bags/...", ja:"例：https://www.prada.com/jp/ja/women/bags/..."},
  goBtn:{en:"Compare Prices", ja:"価格を比較する"},
```

- [ ] **Step 5: Update i18n strings in the T object (dynamic strings)**

Replace/add these entries in `T.en` and `T.ja`:

```js
// In T.en:
    errInvalidUrl: "Please enter a valid HTTPS URL from a brand website.",
    errNotOfficial: (domain) => `"${domain}" is not a recognized official brand website. Please use a URL from the brand's own site (e.g. prada.com, nike.com).`,
    errBlocked: (domain) => `Third-party retailers like "${domain}" are not supported. Please use the brand's official website.`,
    loadScraping: ["Scraping the product page", "Comparing prices across 8 markets", "Checking exchange rates", "Almost there"],
    unavailable: (brand, country) => `Not available on ${brand} ${country}`,

// In T.ja:
    errInvalidUrl: "ブランドサイトの有効なHTTPS URLを入力してください。",
    errNotOfficial: (domain) => `「${domain}」は公式ブランドサイトとして認識されていません。ブランドの公式サイトのURLを使用してください（例：prada.com、nike.com）。`,
    errBlocked: (domain) => `「${domain}」などのセレクトショップには対応していません。ブランドの公式サイトを使用してください。`,
    loadScraping: ["商品ページをスクレイピング中", "8つの市場で価格を比較中", "為替レートを確認中", "もうすぐです"],
    unavailable: (brand, country) => `${brand} ${country}では取り扱いなし`,
```

- [ ] **Step 6: Commit**

```bash
cd /Users/kyle/Ap-macro
git add index.html
git commit -m "feat(frontend): replace upload+name UI with URL input field"
```

---

### Task 6: Replace frontend JS logic (doSearch, renderResults)

**Files:**
- Modify: `index.html` — the `<script>` section

Replace `doSearch` to call `/scrape` instead of `/?q=`, remove upload-related JS, update `renderResults` to handle unavailable countries.

- [ ] **Step 1: Remove upload-related JS**

Delete these functions entirely: `setupUpload`, `handleFile`, `resetUpload`, `doDebrand`, `renderDebrandedStage`, `debrandInBackground`, `loadImage`, `runCurated`, `matchCurated`.

Delete the `CURATED` array and `uploadedImageData` variable.

Delete the `setupUpload()` call from init.

Delete the `#examples` click handler.

- [ ] **Step 2: Add client-side URL validation**

```js
// Client-side URL validation (mirrors worker logic)
const OFFICIAL_DOMAINS = new Set([
  "prada.com","louisvuitton.com","gucci.com","chanel.com","hermes.com",
  "dior.com","balenciaga.com","bottegaveneta.com","saintlaurent.com","ysl.com",
  "burberry.com","fendi.com","loewe.com","celine.com","moncler.com",
  "cartier.com","tiffany.com","rolex.com","omega.com","tagheuer.com",
  "iwc.com","nike.com","adidas.com","newbalance.com"
]);
const BLOCKED_DOMAINS = new Set([
  "farfetch.com","ssense.com","net-a-porter.com","mytheresa.com",
  "matchesfashion.com","nordstrom.com","saksfifthavenue.com",
  "bloomingdales.com","selfridges.com","harrods.com","amazon.com",
  "ebay.com","stockx.com","grailed.com","vestiairecollective.com"
]);
function validateUrl(input) {
  let parsed;
  try { parsed = new URL(input); } catch { return { valid: false, msg: t('errInvalidUrl') }; }
  if (parsed.protocol !== "https:") return { valid: false, msg: t('errInvalidUrl') };
  const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (BLOCKED_DOMAINS.has(domain)) return { valid: false, msg: t('errBlocked', domain) };
  if (!OFFICIAL_DOMAINS.has(domain)) return { valid: false, msg: t('errNotOfficial', domain) };
  return { valid: true, domain };
}
```

- [ ] **Step 3: Replace doSearch function**

```js
async function doSearch(){
  const q = $("#q").value.trim();
  if(!q){ $("#searchMsg").textContent = t('errInvalidUrl'); return; }

  // Client-side validation
  const check = validateUrl(q);
  if(!check.valid){ $("#searchMsg").textContent = check.msg; return; }

  lastQuery = q;
  $("#searchMsg").innerHTML = "";
  $("#debrandSection").classList.remove("hidden");
  $("#resultsSection").classList.add("hidden");

  // Rotating loading messages
  const loadMsgs = t('loadScraping');
  $("#stage").innerHTML = `<div class="loading"><em id="loadMsg">${loadMsgs[0]}</em><span class="dots"></span></div>`;
  let msgIdx = 0;
  const loadTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % loadMsgs.length;
    const el = document.getElementById("loadMsg");
    if(el) el.textContent = loadMsgs[msgIdx];
  }, 5000);

  $("#debrandSection").scrollIntoView({behavior:"smooth",block:"start"});
  revealed = false;

  try {
    const res = await fetch(`${WORKER_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: q, homeCurrency: homeCur() })
    });
    const data = await res.json();
    clearInterval(loadTimer);

    if(!data.found){
      const detail = data.error ? ` (${esc(data.error)})` : "";
      $("#stage").innerHTML = `<div class="quip" style="max-width:580px;margin:40px auto;text-align:center;line-height:1.6">${t('notFound', esc(q), detail)}</div>`;
      $("#resultsSection").classList.add("hidden");
      return;
    }

    const p = data.product;
    const imgUrl = p.image_url || "";

    // Start debranding in parallel if we have an image
    let debrandedImg = null;
    if(imgUrl) {
      try {
        debrandedImg = await debrandFromUrl(imgUrl);
      } catch(e) { console.warn("debrand failed:", e); }
    }

    current = {
      id: "scrape-" + Date.now(),
      name: p.name,
      brand: p.brand,
      category: p.category,
      origin: p.origin,
      img: imgUrl,
      debrandedImg: debrandedImg,
      debrandPending: false,
      blurb: p.blurb || "",
      macro_insight: data.macro_insight || "",
      // New format: prices is { country: { price, currency, available, reason } }
      priceData: data.prices,
      // Legacy format for renderResults compatibility
      prices: data.local_prices || {},
      homePrices: data.home_prices || {},
      homeCurrencyFetched: data.home_currency || homeCur(),
      sources: []
    };
    renderStage();
  } catch(e) {
    clearInterval(loadTimer);
    $("#stage").innerHTML = `<div class="quip" style="max-width:580px;margin:40px auto;text-align:center">${t('errNetworkAI')}</div>`;
  }
}

// Debrand a product image from a URL (download via proxy, send to /debrand)
async function debrandFromUrl(imageUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imageUrl;
  });
  const MAX = 1024;
  let w = img.naturalWidth, h = img.naturalHeight;
  if(w > MAX || h > MAX){
    if(w > h){ h = Math.round(h * MAX / w); w = MAX; }
    else { w = Math.round(w * MAX / h); h = MAX; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];

  const res = await fetch(`${WORKER_URL}/debrand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64, mimeType: "image/jpeg" })
  });
  const d = await res.json();
  return d.success ? `data:${d.mimeType};base64,${d.image}` : null;
}
```

- [ ] **Step 4: Update renderResults to handle unavailable countries**

In `renderResults`, replace the `rows` construction to include unavailable countries:

```js
function renderResults(){
  if(!current) return;
  const it = current;

  // Build rows from the new priceData format
  const availableRows = [];
  const unavailableRows = [];

  for (const country of Object.keys(COUNTRIES)) {
    const pd = it.priceData ? it.priceData[country] : null;
    const localCur = CURRENCY_OF[country];

    if (pd && pd.available && typeof pd.price === "number") {
      const home = (it.homePrices && typeof it.homePrices[country] === "number")
        ? it.homePrices[country]
        : toHome(pd.price, localCur);
      availableRows.push({
        country, cc: (COUNTRIES[country]||{}).cc || "??",
        localCur, local: pd.price, home,
        isHome: country === homeCountry
      });
    } else {
      const reason = (pd && pd.reason) ? pd.reason : t('unavailable', it.brand, cname(country));
      unavailableRows.push({
        country, cc: (COUNTRIES[country]||{}).cc || "??",
        localCur, reason, isHome: country === homeCountry, unavailable: true
      });
    }
  }

  availableRows.sort((a,b) => a.home - b.home);
  const allRows = [...availableRows, ...unavailableRows];

  if(availableRows.length === 0){
    $("#results").innerHTML = `<div class="quip" style="text-align:center;margin:40px auto">${t('noPrices')}</div>`;
    return;
  }

  const max = Math.max(...availableRows.map(r=>r.home));
  const cheapest = availableRows[0], dearest = availableRows[availableRows.length-1];
  const youRow = availableRows.find(r=>r.isHome);
  const youRank = youRow ? availableRows.indexOf(youRow)+1 : null;
  const savePctVsYou = youRow ? ((youRow.home - cheapest.home)/youRow.home*100) : null;
  const spreadPct = (dearest.home - cheapest.home)/dearest.home*100;
  const originIsCheapest = cheapest.country === it.origin;
  const originSold = availableRows.some(r=>r.country === it.origin);

  let verdict = `<div class="verdict">
    <div class="v-top">
      <h3>${t('cheapestLabel')} — <span class="cc">${esc(cname(cheapest.country))}</span></h3>
      <span class="v-price">${fmt(cheapest.home, homeCur())}</span>
    </div>
    <p>${t('mostExpensive', esc(cname(dearest.country)), fmt(dearest.home, homeCur()), spreadPct.toFixed(0))}`;
  if(youRow){
    verdict += ` ${t('boughtHome', esc(cname(homeCountry)), fmt(youRow.home, homeCur()), youRank, availableRows.length)} ${savePctVsYou>0.5 ? t('saveBringBack', esc(cname(cheapest.country)), savePctVsYou.toFixed(0)) : t('alreadyCheapest')}`;
  } else {
    verdict += ` ${t('switchCountry')}`;
  }
  verdict += `</p><p>${originSold ? (originIsCheapest
    ? t('originCheapest', esc(cname(it.origin)))
    : t('originNotCheapest', esc(cname(it.origin))))
    : t('originNotCompared', esc(cname(it.origin)))}</p></div>`;

  // Bar chart (available countries only)
  const chart = `<div class="chart">${availableRows.map(r=>{
    const pct = Math.max(4, r.home/max*100);
    const cls = (r===cheapest?"cheapest":"") + (r.isHome?" home":"");
    return `<div class="bar-row">
      <div class="cy"><span class="cc">${r.cc}</span><span class="nm">${esc(cname(r.country))}</span>${r.isHome?`<span class="you-tag">${t('youTag')}</span>`:''}</div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="bar-val">${fmt(r.home, homeCur())}</div>
    </div>`;
  }).join("")}</div>`;

  // Table (all countries — available + unavailable)
  let rank = 0;
  const table = `<div class="table-scroll"><table>
    <thead><tr><th>#</th><th>${t('thCountry')}</th><th>${t('thLocal')}</th><th>${t('thInCur', homeCur())}</th><th>${t('thTax')}</th></tr></thead>
    <tbody>${allRows.map(r => {
      if (r.unavailable) {
        return `<tr class="unavailable">
          <td>—</td>
          <td class="country"><span class="cc">${r.cc}</span>${esc(cname(r.country))}
            ${r.isHome?`<span class="note-tag">${t('tagYou')}</span>`:''}</td>
          <td colspan="2" class="num">${esc(r.reason)}</td>
          <td>${taxOf(r.country)}</td>
        </tr>`;
      }
      rank++;
      return `<tr>
        <td>${rank}</td>
        <td class="country"><span class="cc">${r.cc}</span>${esc(cname(r.country))}
          ${r.country===it.origin?`<span class="note-tag">${t('tagHome')}</span>`:''}
          ${r===cheapest?`<span class="note-tag">${t('tagCheapest')}</span>`:''}
          ${r.isHome?`<span class="note-tag">${t('tagYou')}</span>`:''}</td>
        <td>${fmt(r.local, r.localCur)}</td>
        <td class="num">${fmt(r.home, homeCur())}</td>
        <td>${taxOf(r.country)}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;

  const macroCallout = it.macro_insight
    ? `<div class="macro-callout"><span class="label">${t('macroLabel')}</span>${esc(it.macro_insight)}</div>`
    : "";

  const genka = it.blurb ? `<div class="genka"><strong>${t('genka')}</strong> ${esc(it.blurb)}</div>` : "";

  $("#results").innerHTML = verdict + macroCallout + chart + table + genka;
}
```

- [ ] **Step 5: Update refetchForCurrency to use /scrape**

```js
async function refetchForCurrency(){
  const query = lastQuery;
  if(!query){ renderStage(); if(revealed) renderResults(); return; }
  const wasRevealed = revealed;
  $(wasRevealed ? "#results" : "#stage").innerHTML = `<div class="loading"><em>${t('updatingPrices')}<span class="dots"></span></em></div>`;
  try{
    const res = await fetch(`${WORKER_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: query, homeCurrency: homeCur() })
    });
    const data = await res.json();
    if(data && data.found){
      current.priceData = data.prices;
      current.prices = data.local_prices || {};
      current.homePrices = data.home_prices || {};
      current.homeCurrencyFetched = data.home_currency || homeCur();
    }
  }catch(e){ /* keep existing data */ }
  renderStage();
  if(wasRevealed) renderResults();
}
```

- [ ] **Step 6: Update init section**

Remove the `setupUpload()` call and `#examples` handler. Keep the rest:

```js
/* ---- init ---- */
$("#goBtn").onclick = doSearch;
$("#q").addEventListener("keydown", e => { if(e.key === "Enter") doSearch(); });
$("#langToggle").onclick = () => setLang(lang === "ja" ? "en" : "ja");
applyLang();
```

- [ ] **Step 7: Verify locally**

Open `index.html` in a browser. Confirm:
- URL input field appears (no upload zone)
- Entering a non-brand URL shows error
- Entering a Nike URL triggers the scrape flow

- [ ] **Step 8: Commit**

```bash
cd /Users/kyle/Ap-macro
git add index.html
git commit -m "feat(frontend): wire up URL-based scrape flow, handle unavailable countries"
```

---

### Task 7: End-to-end test + deploy

**Files:**
- No new files — testing and deployment

- [ ] **Step 1: Deploy worker**

Run: `cd /Users/kyle/Ap-macro/worker && npx wrangler deploy`

- [ ] **Step 2: Test Nike (should work via Firecrawl)**

Open `https://maotabata-apmacro.com/` in browser. Paste:
`https://www.nike.com/t/air-force-1-07-mens-shoes-jBrhbr/CW2288-111`

Expected: product name, image, prices for multiple countries, some possibly unavailable.

- [ ] **Step 3: Test Prada (should work via Gemini fallback)**

Paste: `https://www.prada.com/us/en/women/accessories/card-holders-and-coin-purses/products.1MR034_2HIM_F0G3N.html`

Expected: product identified via Gemini, prices from multiple countries.

- [ ] **Step 4: Test rejection (third-party site)**

Paste: `https://www.farfetch.com/shopping/women/prada/items.aspx`

Expected: instant error message — "Third-party retailers like farfetch.com are not supported."

- [ ] **Step 5: Test unknown domain**

Paste: `https://www.randomsite.com/product/123`

Expected: instant error — "randomsite.com is not a recognized official brand website."

- [ ] **Step 6: Push to GitHub**

```bash
cd /Users/kyle/Ap-macro
git push
```

- [ ] **Step 7: Verify live site**

Visit `https://maotabata-apmacro.com/` and confirm the new URL input flow works end-to-end.
