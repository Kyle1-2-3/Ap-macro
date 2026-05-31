/* =============================================================================
   scrape-core — the agreed "direct official-page scrape + geo + verify" logic.
   Pure functions + a thin Firecrawl fetch. Imported by worker.js AND testable in
   plain node (no Cloudflare globals). No per-brand hardcoding.
   ========================================================================== */

export const COUNTRIES = ["United States","Canada","France","Italy","United Kingdom","Switzerland","Japan","South Korea"];
export const CURRENCY_OF = {
  "United States":"USD","Canada":"CAD","France":"EUR","Italy":"EUR",
  "United Kingdom":"GBP","Switzerland":"CHF","Japan":"JPY","South Korea":"KRW"
};
// Rough USD value of 1 unit — ONLY for a sanity bound on extracted prices, not for display.
const USD_PER = { USD:1, CAD:0.73, EUR:1.08, GBP:1.27, CHF:1.12, JPY:0.0064, KRW:0.00073 };
export const COUNTRY_ISO = {
  "United States":"US","Canada":"CA","France":"FR","Italy":"IT",
  "United Kingdom":"GB","Switzerland":"CH","Japan":"JP","South Korea":"KR"
};
export const LANG_OF = {
  "United States":"en","Canada":"en","France":"fr","Italy":"it",
  "United Kingdom":"en","Switzerland":"de","Japan":"ja","South Korea":"ko"
};

// Candidate {countryCode, lang} variants per market — generic web convention, brand-agnostic.
// Tried in order; first that returns the RIGHT product + RIGHT currency wins. Covers real
// variance (UK = gb|uk, Canada en|fr, Switzerland de|fr|it|en).
export const LOCALE_VARIANTS = {
  "United States":  [["us","en"]],
  "Canada":         [["ca","en"],["ca","fr"]],
  "France":         [["fr","fr"]],
  "Italy":          [["it","it"]],
  "United Kingdom": [["gb","en"],["uk","en"]],
  "Switzerland":    [["ch","en"],["ch","de"],["ch","fr"],["ch","it"]],
  "Japan":          [["jp","ja"]],
  "South Korea":    [["kr","ko"]],
};

// Demandware (Salesforce Commerce Cloud) per-country storefront locale codes (lang_COUNTRY).
// First that verifies wins, same as LOCALE_VARIANTS. CA/CH list their multilingual variants.
export const DW_LOCALE = {
  "United States":  ["en_US"],
  "Canada":         ["en_CA", "fr_CA"],
  "France":         ["fr_FR"],
  "Italy":          ["it_IT"],
  "United Kingdom": ["en_GB"],
  "Switzerland":    ["de_CH", "fr_CH", "it_CH", "en_CH"],
  "Japan":          ["ja_JP"],
  "South Korea":    ["ko_KR"],
};

// Detect a Salesforce Commerce Cloud (Demandware) storefront and extract its site id + origin.
// Looks for the controller path `on/demandware.store/Sites-<ID>-Site` the platform always emits.
// Returns { siteId, origin } or null. Null → Layer 0 is skipped (the no-regression guarantee).
export function detectDemandware(html, inputUrl) {
  if (!html) return null;
  const m = html.match(/demandware\.store\/Sites-([A-Za-z0-9_-]+)-Site/i);
  if (!m) return null;
  let origin;
  try { origin = new URL(inputUrl).origin; } catch { return null; }
  return { siteId: m[1], origin };
}

// Build the standard Demandware product controller URLs for a country (one per locale variant).
// The controller response carries clean JSON-LD that parseProductHtml already reads correctly.
export function demandwareControllerUrls(dw, country, sku) {
  if (!dw || !sku) return [];
  const locales = DW_LOCALE[country] || [];
  return locales.map(
    (loc) => `${dw.origin}/on/demandware.store/Sites-${dw.siteId}-Site/${loc}/Product-Show?pid=${sku}`
  );
}

// Prepend Demandware controller URLs ahead of each country's existing candidates (deduped).
// Pure (no network) so it's unit-testable. Returns the same targets object, mutated and returned.
export function applyDemandwareTargets(targets, dw, sku) {
  if (!dw || !sku) return targets;
  for (const country of COUNTRIES) {
    const ctrl = demandwareControllerUrls(dw, country, sku);
    if (!ctrl.length) continue;
    const existing = (targets[country] || []).filter((u) => !ctrl.includes(u));
    targets[country] = [...ctrl, ...existing];
  }
  return targets;
}

// Currency symbol / loose token → ISO code.
const CUR_MAP = {
  "$":"USD","US$":"USD","USD":"USD","CA$":"CAD","CAD":"CAD","C$":"CAD",
  "€":"EUR","EUR":"EUR","£":"GBP","GBP":"GBP","¥":"JPY","￥":"JPY","JPY":"JPY",
  "円":"JPY","₩":"KRW","KRW":"KRW","원":"KRW","CHF":"CHF","FR":"CHF","SFR":"CHF",
};
export function normCur(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  return CUR_MAP[s] || CUR_MAP[raw] || (/^[A-Z]{3}$/.test(s) ? s : null);
}

// Parse a price string that may use either US (1,234.56) or EU (1.234,56 / 1.300) grouping.
export function normPrice(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const hasDot = s.includes("."), hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // last separator is the decimal one
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")   // EU: 1.234,56
      : s.replace(/,/g, "");                      // US: 1,234.56
  } else if (hasComma) {
    // comma only: decimal if exactly 2 trailing digits, else thousands
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (hasDot) {
    // dot only: thousands if exactly 3 trailing digits (e.g. 1.300), else decimal
    s = /\.\d{3}$/.test(s) ? s.replace(/\./g, "") : s;
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}

// The product code lives in the last path segment. Two common shapes:
//   Prada:  /p/{slug}/1MR034_2HIM_F0G3N           → 1MR034_2HIM_F0G3N
//   Gucci:  /pr/.../gg-marmont-bag-p-443497AABZB1000 → 443497AABZB1000
export function extractCode(productUrl) {
  try {
    const parts = new URL(productUrl).pathname.split("/").filter(Boolean);
    let last = (parts[parts.length-1] || "").replace(/\.(html?|aspx?)$/i, "");
    const pSep = last.match(/[-_]p[-_]([A-Za-z0-9]+)$/i);   // "name-p-CODE"
    if (pSep) return pSep[1];
    return last;
  } catch { return ""; }
}

// Meaningful needles to confirm a scraped page is the same product.
export function codeNeedles(code) {
  const out = new Set();
  const c = String(code || "");
  if (c.length >= 5) out.add(c);
  for (const tok of c.split(/[^A-Za-z0-9]+/)) if (tok.length >= 5 && /\d/.test(tok)) out.add(tok);
  const numRun = c.match(/\d{5,}/);
  if (numRun) out.add(numRun[0]);
  return [...out];
}
export function htmlHasCode(html, code) {
  const needles = codeNeedles(code);
  if (!needles.length) return true;          // can't form a needle → don't reject (currency is the guard)
  const lower = html.toLowerCase();
  return needles.some(n => lower.includes(n.toLowerCase()));
}

// Build per-country CANDIDATE URLs by swapping ONLY the locale segment, keeping the rest of
// the path identical. Three shapes: /{cc}/{lang}/... , /{cc}-{lang}/... , subdomain {cc}.brand.com
export function buildCountryUrls(inputUrl) {
  let u;
  try { u = new URL(inputUrl); } catch { return {}; }
  const segs = u.pathname.split("/").filter(Boolean);
  const isCC = s => /^[a-z]{2}$/i.test(s);
  const isCombo = s => /^[a-z]{2}[-_][a-z]{2}$/i.test(s);
  const out = {};

  if (segs.length >= 2 && isCC(segs[0]) && isCC(segs[1])) {           // /{cc}/{lang}/rest
    const rest = "/" + segs.slice(2).join("/");
    for (const c of COUNTRIES) out[c] = LOCALE_VARIANTS[c].map(([cc,lang]) => `${u.origin}/${cc}/${lang}${rest}`);
    return out;
  }
  if (segs.length >= 1 && isCombo(segs[0])) {                          // /{cc}-{lang}/ or /{lang}-{cc}/
    const rest = "/" + segs.slice(1).join("/");
    const sep = segs[0].includes("_") ? "_" : "-";
    const first = segs[0].split(/[-_]/)[0].toLowerCase();
    const ccSet = new Set(Object.values(COUNTRY_ISO).map(s=>s.toLowerCase()).concat(["uk"]));
    const ccFirst = ccSet.has(first);
    for (const c of COUNTRIES) out[c] = LOCALE_VARIANTS[c].map(([cc,lang]) =>
      `${u.origin}/${ccFirst ? cc+sep+lang : lang+sep+cc}${rest}`);
    return out;
  }
  const sub = u.hostname.match(/^([a-z]{2})\.(.+)$/i);                 // subdomain {cc}.brand.com
  if (sub) {
    for (const c of COUNTRIES) {
      const ccs = [...new Set(LOCALE_VARIANTS[c].map(([cc]) => cc))];
      out[c] = ccs.map(cc => `${u.protocol}//${cc}.${sub[2]}${u.pathname}`);
    }
    return out;
  }

  // No locale segment at all (e.g. Balenciaga "/7897722AA4V1000.html"). Insert a locale prefix
  // after the origin — confirmed working: ".../ja-jp/7897722AA4V1000.html" returns the JP page.
  // Try {lang}-{cc}, {cc}/{lang}, {cc}; the code+currency+range gate filters wrong guesses, so
  // extra candidates only cost a fetch, never correctness. Bare URL kept as a last candidate.
  const path = u.pathname;
  for (const c of COUNTRIES) {
    const cands = [];
    for (const [cc, lang] of LOCALE_VARIANTS[c]) {
      cands.push(`${u.origin}/${lang}-${cc}${path}`);
      cands.push(`${u.origin}/${cc}/${lang}${path}`);
      cands.push(`${u.origin}/${cc}${path}`);
    }
    cands.push(inputUrl);                       // bare page (works for the input's own country)
    out[c] = [...new Set(cands)];
  }
  return out;
}

// Extract price + currency + image + name from raw HTML. Three layers, in order:
//   1) JSON-LD Product offers   2) <meta product:price:*>   3) embedded JS "price"/"priceCurrency"
// In layer 3, prefer the pair whose currency matches `wantCur` (skips recommended-product noise
// and catches geo-redirect bleed).
export function parseProductHtml(html, wantCur, code, opts = {}) {
  const out = { price:null, currency:null, image:null, name:null };
  if (!html) return out;
  // Normalize undecoded HTML entities that sit between a currency symbol and the digits
  // (e.g. Gucci renders "€&nbsp;3.200"). Without this the symbol-based price regex misses.
  html = html
    .replace(/&nbsp;|&#160;|&#xa0;|&#x00a0;/gi, " ")
    .replace(/&euro;/gi, "€").replace(/&pound;/gi, "£").replace(/&yen;/gi, "¥")
    .replace(/&dollar;/gi, "$").replace(/&amp;/gi, "&");

  // Layer 1: JSON-LD
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data; try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const arr = Array.isArray(data) ? data : (data["@graph"] || [data]);
    for (const node of arr) {
      if (!node || !String(node["@type"]||"").toLowerCase().includes("product")) continue;
      if (!out.name && node.name) out.name = String(node.name);
      if (!out.image && node.image) out.image = Array.isArray(node.image) ? node.image[0] : node.image;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      if (offers) {
        const p = normPrice(offers.price ?? offers.lowPrice ?? offers.highPrice);
        const cur = normCur(offers.priceCurrency);
        if (p && (!out.price || (wantCur && cur === wantCur))) { out.price = p; out.currency = cur || out.currency; }
      }
    }
    if (out.price && (!wantCur || out.currency === wantCur)) break;
  }

  // Layer 2: meta tags.
  // structuredOnly (Demandware): trust ONLY the Layer-1 JSON-LD Product offer, the single
  // SKU/product-anchored source. On Demandware consumer PDPs the meta/embedded/text layers pick
  // up NON-product microdata — e.g. a free-shipping threshold marked up as
  // `itemprop="price" content="250.00"` (£250) — so we skip them and prefer an honest blank.
  // The Product-Show controller still carries real JSON-LD, so Layer 1 handles it unaffected.
  if (out.price == null && !opts.structuredOnly) {
    const m = html.match(/property=["']product:price:amount["']\s+content=["']([\d.,]+)["']/i)
           || html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i);
    if (m) out.price = normPrice(m[1]);
    const mc = html.match(/property=["']product:price:currency["']\s+content=["']([A-Za-z]{3})["']/i)
            || html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/i);
    if (mc) out.currency = normCur(mc[1]);
  }

  // Layer 3: embedded JS app-state (Gucci etc. keep the real price only here)
  if (out.price == null && !opts.structuredOnly) {
    const pairs = [];
    let m;
    const rxPC = /"price"\s*:\s*"?(\d[\d.,]*)"?\s*,\s*"priceCurrency"\s*:\s*"?([A-Za-z₩¥£€$￥]{1,4})/gi;
    while ((m = rxPC.exec(html))) pairs.push([m[1], normCur(m[2])]);
    const rxCP = /"priceCurrency"\s*:\s*"?([A-Za-z₩¥£€$￥]{1,4})"?\s*,\s*"price"\s*:\s*"?(\d[\d.,]*)/gi;
    while ((m = rxCP.exec(html))) pairs.push([m[2], normCur(m[1])]);
    const pick = (wantCur && pairs.find(p => p[1] === wantCur)) || pairs[0];
    if (pick) { out.price = normPrice(pick[0]); out.currency = pick[1]; }
  }

  // Layer 3.5: SPA embedded state (__NEXT_DATA__ / __APOLLO_STATE__ / __INITIAL_STATE__ / __NUXT__).
  // Recurse the parsed state for a node carrying a matching-currency price. Trusts ONLY a
  // FORMATTED string price (contains , or .) so an integer "cents" value can't cause a 100×
  // error; currency must equal wantCur, so a wrong-market value can never leak through.
  if (out.price == null && wantCur && !opts.structuredOnly) {
    const st = extractFromState(html, wantCur);
    if (st) { out.price = st.price; out.currency = st.currency; if (!out.image && st.image) out.image = st.image; }
  }

  // Layer 3.75: commerce-platform price markup. Salesforce Commerce Cloud/Demandware often
  // renders the real PDP price as `<span class="value" content="3150.0">CA$3,150.00</span>`
  // without JSON-LD. Read that structured `content` value before falling back to loose visible
  // text, which can contain Lit template ids like `lit$129293845$` that look like prices.
  if (out.price == null && wantCur) {
    const p = extractPriceValueContent(html, wantCur);
    if (p) { out.price = p; out.currency = wantCur; }
  }

  // Layer 4: visible currency-symbol string (rendered pages often show price only as text,
  // e.g. "$3,950" / "€ 2.650" / "¥ 510,400"). Keyed strictly to THIS country's symbol, so
  // there's no currency ambiguity. PRIORITY 1: a price marked as the main product price
  // (data-testid/class/itemprop containing "product...price" or itemprop="price") — this
  // beats the frequency heuristic, which otherwise picks a repeated recommended-item price
  // (e.g. Gucci shows the real €3.200 once but a related bag €2.900 five times). PRIORITY 2:
  // most-frequent symbol amount as a fallback.
  if (out.price == null && wantCur && !opts.structuredOnly) {
    const SYM = { USD:"\\$", CAD:"(?:CA\\$|C\\$|\\$)", EUR:"€", GBP:"£", JPY:"[¥￥]", KRW:"₩", CHF:"(?:CHF|SFr\\.?)" };
    const sym = SYM[wantCur];
    if (sym) {
      const amount = `${sym}\\s?([0-9][0-9.,]{1,12})`;
      // Priority 1: a "product price"-tagged element, symbol on either side of the number.
      const tagged = new RegExp(
        `(?:product[-_]?price|itemprop=["']price["'][^>]*)[^<>]{0,80}?(?:${amount}|([0-9][0-9.,]{1,12})\\s?${sym})`, "i"
      );
      const tm = html.match(tagged);
      if (tm) { const p = normPrice(tm[1] || tm[2]); if (p) { out.price = p; out.currency = wantCur; } }
      // Priority 2: most-frequent symbol amount.
      if (out.price == null) {
        const rx = new RegExp(amount, "g");
        const counts = {};
        let m;
        while ((m = rx.exec(html))) { const p = normPrice(m[1]); if (p) counts[p] = (counts[p] || 0) + 1; }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (best) { out.price = parseFloat(best[0]); out.currency = wantCur; }
      }
    }
  }

  // Currency backfill: a price found via itemprop/meta may have NO priceCurrency (e.g. Bottega:
  // `itemprop="price" content="1100.00"> $ 1,100`). The strict gate rejects unknown currency, so
  // confirm the country's own currency symbol/code is actually on the page, then set it. This
  // keeps the geo-redirect guard intact — a page showing only "$" is never accepted as e.g. JPY.
  if (out.price != null && !out.currency && wantCur) {
    const PRES = { USD:/\$|USD/, CAD:/\$|CAD/, EUR:/€|EUR/, GBP:/£|GBP/, JPY:/[¥￥]|JPY/, KRW:/₩|KRW/, CHF:/CHF|SFr/i };
    const re = PRES[wantCur];
    if (re && re.test(html)) out.currency = wantCur;
  }

  // Image — try og:image first; if absent (e.g. Bottega has no OG/JSON-LD), fall back to an
  // <img>/srcset URL whose filename contains the product code (so it's THIS product, not a
  // recommended item). codeNeedles() gives the meaningful code tokens.
  if (!out.image) {
    const og = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og) out.image = og[1];
  }
  if (!out.image && code) {
    const needles = codeNeedles(code).map(n => n.toLowerCase());
    if (needles.length) {
      const urls = html.match(/https?:\/\/[^"'\s)]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\s)]*)?/gi) || [];
      const hit = urls.find(u => needles.some(n => u.toLowerCase().includes(n)));
      if (hit) out.image = hit;
    }
  }
  // Last-resort image: some sites use a different code in the URL than in the image filename
  // (e.g. Balenciaga en-ca URL code 813472606 but image code 7897792AA4V1000). When code-matching
  // fails, take the largest-looking product image from a media/asset/dam CDN, skipping icons,
  // logos, sprites, swatches and tiny thumbnails. It's still an image from THIS product page.
  if (!out.image) {
    const urls = [...new Set(html.match(/https?:\/\/[^"'\s)]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\s)]*)?/gi) || [])];
    const cdn = urls.filter(u => /\b(dam|asset|assets|media|cdn|images?|scene7)\b/i.test(u)
      && !/(logo|icon|sprite|swatch|favicon|placeholder|flag|badge)/i.test(u)
      && !/(thumbnail|thumb|small|mini|micro|\b\d{2,3}x\d{2,3}\b)/i.test(u));
    // Prefer an explicitly large rendition if present, else the first qualifying CDN image.
    const big = cdn.find(u => /\b(large|zoom|original|2048|1600|1200|hero|medium)\b/i.test(u));
    if (big || cdn[0]) out.image = big || cdn[0];
  }

  // Name — fall back to the first <h1> when structured data didn't supply one.
  if (!out.name) {
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) {
      const t = h1[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (t && t.length <= 120) out.name = t;
    }
  }
  return out;
}

function extractPriceValueContent(html, wantCur) {
  const PRES = {
    USD: /\$|USD/i, CAD: /CA\$|C\$|CAD/i, EUR: /€|EUR/i, GBP: /£|GBP/i,
    JPY: /[¥￥]|JPY|円/i, KRW: /₩|KRW|원/i, CHF: /CHF|SFr/i,
  };
  const curRe = PRES[wantCur];
  if (!curRe) return null;
  const hits = [];
  const re = /<span\b[^>]*class=["'][^"']*\bvalue\b[^"']*["'][^>]*\bcontent=["']([\d.,]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const price = normPrice(m[1]);
    if (!price) continue;
    const around = html.slice(Math.max(0, m.index - 600), Math.min(html.length, m.index + 900));
    if (!curRe.test(around)) continue;
    if (!/(price|prices|sales|list|product[-_]?header)/i.test(around)) continue;
    const rank = /\blist\b|regular|standard|was-price|strike/i.test(around) ? 0 : 1;
    hits.push({ price, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || b.price - a.price);
  return hits[0]?.price || null;
}

// Return the brace-balanced JSON object literal starting at/after fromIdx (string-aware), or null.
function balancedJsonAfter(str, fromIdx) {
  const start = str.indexOf("{", fromIdx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

// Recurse a parsed state object for a node with a price + matching currency. Only accepts a
// FORMATTED string price (has a , or .) to dodge the integer-cents 100× trap; currency must match.
export function findStatePrice(node, wantCur, depth = 0) {
  if (!node || typeof node !== "object" || depth > 10) return null;
  const keys = Object.keys(node);
  const pk = keys.find(k => /^(price|saleprice|currentprice|finalprice|sellingprice|amount)$/i.test(k));
  const ck = keys.find(k => /(pricecurrency|currencycode|currency|isocurrencycode)/i.test(k) && typeof node[k] === "string");
  if (pk && ck) {
    const raw = node[pk], c = normCur(node[ck]);
    if (c === wantCur && typeof raw === "string" && /[.,]/.test(raw)) {
      const p = normPrice(raw);
      if (p) {
        const img = node.image || node.imageUrl || node.imageURL;
        return { price: p, currency: c, image: typeof img === "string" ? img : null };
      }
    }
  }
  for (const k of keys) {
    const r = findStatePrice(node[k], wantCur, depth + 1);
    if (r) return r;
  }
  return null;
}

// Pull SPA state blobs (__NEXT_DATA__ script + window.__X_STATE__ assignments) and search them.
export function extractFromState(html, wantCur) {
  if (!html) return null;
  const blobs = [];
  const nx = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nx) blobs.push(nx[1]);
  const re = /(?:__APOLLO_STATE__|__INITIAL_STATE__|__PRELOADED_STATE__|__NUXT__|__INITIAL_DATA__)\s*=/g;
  let m;
  while ((m = re.exec(html))) { const b = balancedJsonAfter(html, m.index + m[0].length); if (b) blobs.push(b); }
  for (const b of blobs) {
    let data; try { data = JSON.parse(b.trim()); } catch { continue; }
    const hit = findStatePrice(data, wantCur);
    if (hit) return hit;
  }
  return null;
}

// Small sleep + bounded-concurrency map. Firecrawl returns random 408/429/5xx when hit with
// 8 simultaneous requests; capping parallelism and retrying makes results deterministic.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Firecrawl-fetch one URL's rendered HTML, with geo + stealth + retry. Returns { html } or
// { error }. Rendered `html` (JS executed) — NOT rawHtml — passes the anti-bot challenge that
// returns a 4.5KB "Access Denied" for rawHtml on many brands. Retries transient 408/429/5xx
// (and network errors) with exponential backoff; these appear randomly under load and are the
// main cause of non-deterministic, flaky coverage.
export async function fcGetHtml(targetUrl, country, fcKey, fetchImpl = fetch) {
  const reqBody = JSON.stringify({
    url: targetUrl,
    formats: ["html"],
    location: { country: COUNTRY_ISO[country] || "US", languages: [LANG_OF[country] || "en"] },
    proxy: "stealth",
    waitFor: 4000,
    timeout: 40000,
  });
  let res, delay = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${fcKey}`, "Content-Type":"application/json" },
        body: reqBody,
      });
    } catch (e) {
      if (attempt === 2) return { error: "fetch: " + String(e).slice(0,60) };
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      if (attempt === 2) return { error: `Firecrawl ${res.status}` };
      await sleep(delay); delay *= 2; continue;
    }
    break;
  }
  if (!res.ok) return { error: `Firecrawl ${res.status}` };
  const data = await res.json();
  const html = data?.data?.html || data?.data?.rawHtml || "";
  if (!html) return { error: "No HTML" };
  return { html };
}

// Scrape one URL then verify (product code present + currency matches the country).
export async function scrapeOne(targetUrl, country, code, fcKey, fetchImpl = fetch, structuredOnly = false) {
  if (!fcKey) return { ok:false, country, reason:"No Firecrawl key" };
  const wantCur = CURRENCY_OF[country];
  const got = await fcGetHtml(targetUrl, country, fcKey, fetchImpl);
  if (got.error) return { ok:false, country, reason:got.error, url:targetUrl };
  const html = got.html;
  if (code && !htmlHasCode(html, code)) return { ok:false, country, reason:"Product code not on page", url:targetUrl };

  const parsed = parseProductHtml(html, wantCur, code, { structuredOnly });
  if (!parsed.price) return { ok:false, country, reason:"No price found", url:targetUrl };
  // Strict: a price with unknown/mismatched currency is NOT trusted (prevents stray numbers
  // like a year being accepted). Genuine extractions always set currency to the country currency.
  if (parsed.currency !== wantCur)
    return { ok:false, country, reason:`Currency ${parsed.currency||"unknown"}≠${wantCur}`, url:targetUrl };

  // Sanity range (USD-equivalent): rejects garbage like a concatenated "€193.882.746" that
  // passes the currency check. Bounds are wide enough for any real luxury item ($20–$1M).
  const usd = parsed.price * (USD_PER[wantCur] || 1);
  if (!(usd >= 20 && usd <= 1_000_000))
    return { ok:false, country, reason:`Price out of range (${parsed.price} ${wantCur})`, url:targetUrl };

  return { ok:true, country, price:parsed.price, currency:wantCur, image:parsed.image, name:parsed.name, url:targetUrl, via:"text" };
}

// Try each candidate locale URL for a country until one verifies. If ALL text-extraction
// candidates fail and a visionFn is supplied, fall back to reading a screenshot of the most
// likely URL (the first candidate). The vision result passes the SAME currency + sanity gate,
// so a wrong read can only fail, never mislead. visionFn(url, country, wantCur) -> {price,currency}|null
export async function scrapeCountry(candidateUrls, country, code, fcKey, fetchImpl = fetch, visionFn = null, structuredOnly = false) {
  if (!candidateUrls || !candidateUrls.length) return { ok:false, country, reason:"No URL for country" };
  let last = { ok:false, country, reason:"No candidate verified" };
  for (const u of candidateUrls) {
    const r = await scrapeOne(u, country, code, fcKey, fetchImpl, structuredOnly);
    if (r.ok) return r;
    last = r;
  }
  // Vision fallback — only when text failed and a vision reader is available.
  if (visionFn) {
    const wantCur = CURRENCY_OF[country];
    try {
      const v = await visionFn(candidateUrls[0], country, wantCur);
      if (v && v.price && normCur(v.currency) === wantCur) {
        const usd = Number(v.price) * (USD_PER[wantCur] || 1);
        if (usd >= 20 && usd <= 1_000_000)
          return { ok:true, country, price:Number(v.price), currency:wantCur, image:v.image||null, name:v.name||null, url:candidateUrls[0], via:"vision" };
      }
    } catch { /* vision is best-effort */ }
  }
  return last;
}

// Parse <link rel="alternate" hreflang="…" href="…"> tags → { countryCodeLower: href }.
// Region subtag wins (en-us→us, ja-jp→jp); a few sites use language-only codes (ja/ko) that
// still imply a market. The site itself declaring these URLs beats any locale-swap guess.
const LANG_ONLY_CC = { ja:"jp", ko:"kr" };
export function parseHreflang(html) {
  const out = {};
  if (!html) return out;
  const re = /<link\b[^>]*\brel=["']alternate["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const hl = (tag.match(/hreflang=["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!hl || !href) continue;
    const loc = hl.toLowerCase();
    let cc = loc.includes("-") ? loc.split("-").pop() : LANG_ONLY_CC[loc];
    if (cc && /^[a-z]{2}$/.test(cc) && !out[cc]) out[cc] = href;
  }
  return out;
}

// Map a 2-letter country code (lowercase) → our country name. "uk" aliases the UK.
function ccToCountry() {
  const m = {};
  for (const c of COUNTRIES) m[COUNTRY_ISO[c].toLowerCase()] = c;
  m["uk"] = "United Kingdom";
  return m;
}

// Best-effort: which of our 8 countries the INPUT url is for (from its locale segment/subdomain).
function inputCountryOf(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const map = ccToCountry();
    const cand = [];
    const sub = u.hostname.match(/^([a-z]{2})\./i);
    if (sub) cand.push(sub[1].toLowerCase());
    for (const s of u.pathname.split("/").filter(Boolean).slice(0, 2)) {
      if (/^[a-z]{2}$/i.test(s)) cand.push(s.toLowerCase());
      const cm = s.match(/^([a-z]{2})[-_]([a-z]{2})$/i);
      if (cm) { cand.push(cm[1].toLowerCase()); cand.push(cm[2].toLowerCase()); }
    }
    for (const c of cand) if (map[c]) return map[c];
  } catch { /* fall through */ }
  return null;
}

// Full pipeline: input URL → { found, prices, failed, image, name }. All 8 countries in parallel.
export async function scrapeAll(inputUrl, fcKey, fetchImpl = fetch, visionFn = null) {
  const code = extractCode(inputUrl);
  const targets = buildCountryUrls(inputUrl);  // may be {} when the URL has no locale segment
  let isDemandware = false;  // set true once we detect the platform, to suppress text-guessing

  // Discovery: read hreflang off the input page → authoritative per-country product URLs straight
  // from the site (no guessing). This is also the ONLY discovery path for locale-less URLs like
  // Loewe (/.../A510P89X02-7610.html) or Balenciaga (/7897722AA4V1000.html) where buildCountryUrls
  // returns {}. Best-effort & non-regressive: failure keeps locale-swap candidates, and every
  // hreflang URL still passes code+currency verification — a bad URL can only fail, never mislead.
  if (fcKey) {
    try {
      const inCountry = inputCountryOf(inputUrl) || "United States";
      const got = await fcGetHtml(inputUrl, inCountry, fcKey, fetchImpl);
      if (got.html) {
        const hl = parseHreflang(got.html);
        const cc2c = ccToCountry();
        for (const [cc, href] of Object.entries(hl)) {
          const country = cc2c[cc];
          if (!country) continue;
          const existing = targets[country] || [];
          targets[country] = [href, ...existing.filter(u => u !== href)];  // hreflang URL first
        }
        // Layer 0: if this is a Demandware storefront, prepend the standard product controller
        // URLs (which carry clean JSON-LD) ahead of the consumer-PDP candidates. The same
        // currency + sanity + outlier gates still apply, so a bad controller read can only fail.
        const dw = detectDemandware(got.html, inputUrl);
        if (dw) { applyDemandwareTargets(targets, dw, code); isDemandware = true; }
      }
    } catch { /* keep whatever candidates we have */ }
  }

  // Only now decide there's nothing to try (neither a locale pattern nor hreflang yielded URLs).
  if (!Object.keys(targets).length) {
    return { found:false, error:"Could not derive per-country URLs (no locale segment, no hreflang)", code, prices:{}, failed:[] };
  }

  // All 8 countries in parallel. Firecrawl tolerates 8 concurrent (verified for screenshots);
  // the per-fetch 408/429/5xx retry in fcGetHtml absorbs any transient load errors. Full
  // parallelism is what keeps the vision fallback fast (8×~25s screenshots overlap, ~30s wall
  // instead of ~200s serial) — critical for Rimowa-class pages where most countries use vision.
  const settled = await mapLimit(
    COUNTRIES, 8,
    c => scrapeCountry(targets[c], c, code, fcKey, fetchImpl, visionFn, isDemandware)
  );
  const prices = {}, failed = [];
  let image = null, name = null;
  for (const r of settled) {
    if (r.ok) {
      prices[r.country] = { price:r.price, currency:r.currency, via:r.via || "text" };
      if (!image && r.image) image = r.image;
      if (!name && r.name) name = r.name;
    } else {
      failed.push({ country:r.country, reason:r.reason });
    }
  }

  // Cross-country outlier rejection. A single page can expose several prices (recommended items,
  // installment amounts, accessories) and the per-page parser may grab the wrong one — e.g. a JP
  // page showing ¥77,000 (an unrelated item) instead of the bag's real price. Convert every
  // country's price to USD, take the median, and drop any country whose USD value is wildly off
  // (<0.3× or >3× the median). The same product can't legitimately be 8× cheaper in one market;
  // honest "couldn't verify" beats a nonsense number. Needs ≥3 prices to have a trustworthy median.
  const usdOf = (info) => info.price * (USD_PER[info.currency] || 0);
  const entries = Object.entries(prices);
  if (entries.length >= 3) {
    const usds = entries.map(([, v]) => usdOf(v)).filter(x => x > 0).sort((a, b) => a - b);
    const median = usds[Math.floor(usds.length / 2)];
    for (const [country, v] of entries) {
      const u = usdOf(v);
      if (u > 0 && (u < median * 0.3 || u > median * 3)) {
        delete prices[country];
        failed.push({ country, reason: `Price out of line vs other markets ($${Math.round(u)} vs median $${Math.round(median)})` });
      }
    }
  }

  return { found: Object.keys(prices).length >= 1, code, prices, failed, image, name };
}
