# Implementation Plan — hreflang-driven official price + image (8 countries) + logo removal

_Date: 2026-05-30 · target: `worker/scrape-core.mjs` (+ `worker/worker.js` wiring)_

> Written while the build env's tool-output channel was degraded (couldn't reliably re-read
> existing source). Therefore this is a **drop-in plan with complete code for the NEW pieces**,
> designed to be integrated WITHOUT clobbering the existing working extractor (Bottega 8/8, Prada).
> Integrate the functions below; keep existing JSON-LD/OG/state/regex extractor as the per-page
> extraction core if it already exists — this plan only REPLACES the discovery step and adds a
> universal verification gate.

## Goal (locked, from user)

Input = ONE official product URL. Output for 8 countries: official **price + image**, with the
displayed image **logo-removed**. If a product isn't sold in a country → `Product not found in
this country`. Never fake/guess a price.

8 countries: US/CA/FR/IT/GB/CH/JP/KR.

## Core decisions

1. **Discovery (find each country's product URL), first that VERIFIES wins:**
   - (1) `hreflang` alternates on the input product page — authoritative, per-product.
     Confirmed coverage 2026-05-30: Prada/Hermès/Margiela 8/8; Balenciaga 7/8 (no CH);
     Thom Browne 7/8; Givenchy maps JP/KR via language codes (ja/ko) not region — handle that.
   - (2) locale-segment transposition of the input URL (`/us/en/` → `/kr/ko/`, `us.` → `kr.`).
   - (3) (optional, last resort) Gemini hint — only if (1)(2) fail.
2. **Universal verification gate (applies to EVERY candidate URL, any source):** accept a price
   only if the page yields a price whose **priceCurrency === that country's currency**. This single
   check kills hallucinated URLs, geo-redirects, and wrong-country pages.
3. **All fetching via Firecrawl v2 `/scrape`** (rendered + stealth + geo) — direct fetch is
   blocked by LV/Gucci/Chanel and misses JS-injected tags (verified 2026-05-30). No firecrawl CLI;
   use REST. `FIRECRAWL_API_KEY` is in the user's `~/.zshrc` locally and must be a Worker secret.
4. **Image:** take ONE canonical official image (JSON-LD `image` or `og:image`) from the input
   page; the existing `/debrand` (Gemini 2.5 Flash Image) removes the logo. One image suffices —
   no need to debrand 8 images.
5. **Honesty:** country absent from hreflang → `Product not found in this country`. URL existed but
   no verifiable price → `Couldn't verify official price`. (User OK to collapse both to "not found"
   — keep two reasons internally, show one if simpler.)
6. **Infra:** concurrency cap 2–3 + exponential backoff on 408/429/5xx (kills Firecrawl flakiness);
   per-scrape timeout so one slow country can't stall the response.

## New code (drop into scrape-core.mjs)

```js
/* ============ Target countries ============ */
export const TARGETS = {
  "United States":  { cc: "us", lang: "en", cur: "USD" },
  "Canada":         { cc: "ca", lang: "en", cur: "CAD" },
  "France":         { cc: "fr", lang: "fr", cur: "EUR" },
  "Italy":          { cc: "it", lang: "it", cur: "EUR" },
  "United Kingdom": { cc: "gb", lang: "en", cur: "GBP" },
  "Switzerland":    { cc: "ch", lang: "de", cur: "CHF" },
  "Japan":          { cc: "jp", lang: "ja", cur: "JPY" },
  "South Korea":    { cc: "kr", lang: "ko", cur: "KRW" },
};
const LANG_TO_CC = { ja: "jp", ko: "kr", en: null, fr: null, de: null, it: null }; // lang-only hreflang → region

/* ============ Firecrawl v2 scrape (rendered, geo, retry) ============ */
export async function fcScrape(url, apiKey, { country, waitFor = 3500, tries = 3 } = {}) {
  const body = {
    url,
    formats: ["rawHtml", "markdown"],
    onlyMainContent: false,
    waitFor,
    timeout: 30000,
    ...(country ? { location: { country: country.toUpperCase(), languages: [] } } : {}),
  };
  let delay = 800;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (r.status === 408 || r.status === 429 || r.status >= 500) throw new Error("retryable " + r.status);
      if (!r.ok) return null;
      const d = await r.json();
      const data = d.data || d;
      return { html: data.rawHtml || "", markdown: data.markdown || "", meta: data.metadata || {} };
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }
  return null;
}

/* ============ Discovery: hreflang ============ */
export function parseHreflang(html) {
  const out = {}; // ccLower -> href
  if (!html) return out;
  const re = /<link\b[^>]*\brel=["']alternate["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const hl = (tag.match(/hreflang=["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!hl || !href) continue;
    const loc = hl.toLowerCase();
    let cc = null;
    const dash = loc.split("-");
    if (dash.length >= 2) cc = dash[dash.length - 1];          // en-us -> us, ja-jp -> jp
    else if (loc in LANG_TO_CC) cc = LANG_TO_CC[loc];           // ja -> jp, ko -> kr (Givenchy)
    if (cc && !out[cc]) out[cc] = href;
  }
  return out;
}

/* ============ Discovery: locale-swap fallback ============ */
export function localeSwap(inputUrl, target) {
  try {
    const u = new URL(inputUrl);
    // subdomain pattern: us.brand.com -> kr.brand.com
    if (/^[a-z]{2}\./i.test(u.hostname)) u.hostname = u.hostname.replace(/^[a-z]{2}\./i, target.cc + ".");
    // path patterns: /us/en/ , /en-us/ , /us/
    u.pathname = u.pathname
      .replace(/\/[a-z]{2}-[a-z]{2}\//i, `/${target.lang}-${target.cc}/`)
      .replace(/\/[a-z]{2}\/[a-z]{2}\//i, `/${target.cc}/${target.lang}/`)
      .replace(/\/[a-z]{2,3}-[a-z]{2}(\/|$)/i, `/${target.lang}-${target.cc}$1`);
    return u.toString();
  } catch { return null; }
}

/* ============ Extraction (per page) — reuse existing extractor if present ============ */
// extractFromHtml(html, expectedCurrency) should try, in order:
//   1) JSON-LD  schema.org Product -> offers.price + offers.priceCurrency + image + name
//   2) <meta property="og:price:amount"> / "product:price:amount" + og:price:currency
//   3) embedded state __NEXT_DATA__/__APOLLO_STATE__/__INITIAL_STATE__ (recurse price/currency)
//   4) currency-symbol regex (last resort)
// Return { price, currency, image, name } | null
export function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let json; try { json = JSON.parse(b[1].trim()); } catch { continue; }
    const nodes = [];
    const push = (x) => { if (x && typeof x === "object") nodes.push(x); };
    if (Array.isArray(json)) json.forEach(push); else { push(json); if (Array.isArray(json["@graph"])) json["@graph"].forEach(push); }
    for (const n of nodes) {
      const t = n["@type"];
      const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product"));
      if (!isProduct) continue;
      let offer = n.offers; if (Array.isArray(offer)) offer = offer[0];
      const price = offer && (offer.price ?? offer.lowPrice);
      const cur = offer && offer.priceCurrency;
      const image = Array.isArray(n.image) ? n.image[0] : n.image;
      if (price != null && cur) return { price: Number(price), currency: String(cur).toUpperCase(), image: image || null, name: n.name || null };
    }
  }
  return null;
}

/* ============ Verification gate ============ */
export function verify(extracted, expectedCurrency) {
  if (!extracted || extracted.price == null || !extracted.currency) return false;
  if (extracted.currency.toUpperCase() !== expectedCurrency) return false; // THE safety net
  const p = Number(extracted.price);
  return Number.isFinite(p) && p > 0;
}

/* ============ Orchestrator ============ */
export async function scrapeAllCountries(inputUrl, fcKey) {
  // 1. scrape input page
  const base = await fcScrape(inputUrl, fcKey, { waitFor: 4000 });
  if (!base) return { error: "Could not load the product page" };
  const baseExtract = extractJsonLd(base.html) || {};           // gives canonical name + image
  const hl = parseHreflang(base.html);

  // 2. build candidate URL per country
  const candidates = {};
  for (const [country, t] of Object.entries(TARGETS)) {
    candidates[country] = hl[t.cc] || localeSwap(inputUrl, t); // hreflang first, swap fallback
    if (!hl[t.cc] && !localeSwap(inputUrl, t)) candidates[country] = null;
  }

  // 3. fetch + extract + verify, concurrency 3
  const entries = Object.entries(TARGETS);
  const prices = {};
  const queue = [...entries];
  async function worker() {
    while (queue.length) {
      const [country, t] = queue.shift();
      const url = candidates[country];
      const fromHreflang = !!hl[t.cc];
      if (!url) { prices[country] = { available: false, reason: "Product not found in this country" }; continue; }
      const page = await fcScrape(url, fcKey, { country: t.cc });
      const ext = page ? extractJsonLd(page.html) : null; // extend with og/state/regex tiers
      if (verify(ext, t.cur)) {
        prices[country] = { available: true, price: Number(ext.price), currency: t.cur, source: url };
      } else if (!fromHreflang) {
        // swap-guessed URL didn't verify -> treat as not sold
        prices[country] = { available: false, reason: "Product not found in this country", source: url };
      } else {
        prices[country] = { available: false, reason: "Couldn't verify official price", source: url };
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  return {
    product: { name: baseExtract.name || null, image_url: baseExtract.image || null },
    prices,
  };
}
```

## Wiring in worker.js (`/scrape` handler)

1. Replace the current Firecrawl-Search + `geminiBatchSearchPrices` price path with
   `scrapeAllCountries(inputUrl, env.FIRECRAWL_API_KEY)`.
2. Keep: `validateOfficialSite`, `getRates`/FX conversion (build `local_prices`, `home_prices`),
   image proxy (`/img`), and `macro_insight` (Gemini, insight only).
3. Image → logo removal: return `product.image_url` (proxied); frontend posts it to existing
   `/debrand`. (Or add server-side: fetch image → call `/debrand` → return debranded base64.)
4. Response shape stays compatible with `index.html`: `product.*`, `prices`, `local_prices`,
   `home_prices`, `failed`, `macro_insight`. Map `available:false` rows into `failed` /
   "Product not found in this country".
5. **Remove Gemini from the price path entirely** (only insight + optional metadata fallback).

## Testing (do when channel healthy)

Use `FIRECRAWL_API_KEY` from `~/.zshrc`; call `scrapeAllCountries` on REAL product URLs (not
homepages) across ~10–15 random brands incl. the bot-blocked ones (LV/Gucci/Chanel/Burberry/
Bottega). Record honest per-brand `verified/8`. Redirect output to a file + md5 to dodge the
env's output corruption; RE-READ before reporting numbers (this is how the false "7 brands work"
claim happened before). Success bar: most brands ≥6/8 with priceCurrency-verified prices; the rest
honestly "not found".

## Remaining (user actions — no creds in build env)

- `git push -u origin feat/url-scrape`
- `cd worker && wrangler secret put FIRECRAWL_API_KEY && wrangler deploy`
- Browser E2E on the live site.
