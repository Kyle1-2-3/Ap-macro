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
  return out;
}

// Extract price + currency + image + name from raw HTML. Three layers, in order:
//   1) JSON-LD Product offers   2) <meta product:price:*>   3) embedded JS "price"/"priceCurrency"
// In layer 3, prefer the pair whose currency matches `wantCur` (skips recommended-product noise
// and catches geo-redirect bleed).
export function parseProductHtml(html, wantCur) {
  const out = { price:null, currency:null, image:null, name:null };
  if (!html) return out;

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

  // Layer 2: meta tags
  if (out.price == null) {
    const m = html.match(/property=["']product:price:amount["']\s+content=["']([\d.,]+)["']/i)
           || html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i);
    if (m) out.price = normPrice(m[1]);
    const mc = html.match(/property=["']product:price:currency["']\s+content=["']([A-Za-z]{3})["']/i)
            || html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/i);
    if (mc) out.currency = normCur(mc[1]);
  }

  // Layer 3: embedded JS app-state (Gucci etc. keep the real price only here)
  if (out.price == null) {
    const pairs = [];
    let m;
    const rxPC = /"price"\s*:\s*"?(\d[\d.,]*)"?\s*,\s*"priceCurrency"\s*:\s*"?([A-Za-z₩¥£€$￥]{1,4})/gi;
    while ((m = rxPC.exec(html))) pairs.push([m[1], normCur(m[2])]);
    const rxCP = /"priceCurrency"\s*:\s*"?([A-Za-z₩¥£€$￥]{1,4})"?\s*,\s*"price"\s*:\s*"?(\d[\d.,]*)/gi;
    while ((m = rxCP.exec(html))) pairs.push([m[2], normCur(m[1])]);
    const pick = (wantCur && pairs.find(p => p[1] === wantCur)) || pairs[0];
    if (pick) { out.price = normPrice(pick[0]); out.currency = pick[1]; }
  }

  if (!out.image) {
    const og = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og) out.image = og[1];
  }
  return out;
}

// Firecrawl scrape one URL with geo + stealth, then verify (code present + currency matches).
export async function scrapeOne(targetUrl, country, code, fcKey, fetchImpl = fetch) {
  if (!fcKey) return { ok:false, country, reason:"No Firecrawl key" };
  const wantCur = CURRENCY_OF[country];
  let res;
  try {
    res = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
      method:"POST",
      headers:{ "Authorization":`Bearer ${fcKey}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        url: targetUrl,
        formats: ["rawHtml"],
        location: { country: COUNTRY_ISO[country], languages: [LANG_OF[country]] },
        proxy: "stealth",
        timeout: 25000,
      }),
    });
  } catch (e) { return { ok:false, country, reason:"fetch: "+String(e).slice(0,60), url:targetUrl }; }
  if (!res.ok) return { ok:false, country, reason:`Firecrawl ${res.status}`, url:targetUrl };

  const data = await res.json();
  const html = data?.data?.rawHtml || "";
  if (!html) return { ok:false, country, reason:"No HTML", url:targetUrl };
  if (code && !htmlHasCode(html, code)) return { ok:false, country, reason:"Product code not on page", url:targetUrl };

  const parsed = parseProductHtml(html, wantCur);
  if (!parsed.price) return { ok:false, country, reason:"No price found", url:targetUrl };
  if (parsed.currency && parsed.currency !== wantCur)
    return { ok:false, country, reason:`Currency ${parsed.currency}≠${wantCur}`, url:targetUrl };

  return { ok:true, country, price:parsed.price, currency:wantCur, image:parsed.image, name:parsed.name, url:targetUrl };
}

// Try each candidate locale URL for a country until one verifies.
export async function scrapeCountry(candidateUrls, country, code, fcKey, fetchImpl = fetch) {
  if (!candidateUrls || !candidateUrls.length) return { ok:false, country, reason:"No URL for country" };
  let last = { ok:false, country, reason:"No candidate verified" };
  for (const u of candidateUrls) {
    const r = await scrapeOne(u, country, code, fcKey, fetchImpl);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

// Full pipeline: input URL → { found, prices, failed, image, name }. All 8 countries in parallel.
export async function scrapeAll(inputUrl, fcKey, fetchImpl = fetch) {
  const code = extractCode(inputUrl);
  const targets = buildCountryUrls(inputUrl);
  if (!Object.keys(targets).length) return { found:false, error:"URL has no recognizable locale segment", code };

  const settled = await Promise.all(
    COUNTRIES.map(c => scrapeCountry(targets[c], c, code, fcKey, fetchImpl))
  );
  const prices = {}, failed = [];
  let image = null, name = null;
  for (const r of settled) {
    if (r.ok) {
      prices[r.country] = { price:r.price, currency:r.currency };
      if (!image && r.image) image = r.image;
      if (!name && r.name) name = r.name;
    } else {
      failed.push({ country:r.country, reason:r.reason });
    }
  }
  return { found: Object.keys(prices).length >= 1, code, prices, failed, image, name };
}
