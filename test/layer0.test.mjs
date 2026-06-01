import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  detectGlobalE,
  detectDemandware,
  demandwareControllerUrls,
  applyDemandwareTargets,
  extractCode,
  parseProductHtml,
  scrapeCountry,
  scrapeOne,
  scrapeAll,
} from "../worker/scrape-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

// --- Task 1: detectDemandware ---

test("detectDemandware finds the site id on a Demandware page", () => {
  const html = fx("rimowa_pdp_gb.html");
  const dw = detectDemandware(html, "https://www.rimowa.com/gb/en/luggage/colour/purple/x/83273171.html");
  assert.ok(dw, "should detect Demandware");
  assert.equal(dw.siteId, "Rimowa");
  assert.equal(dw.origin, "https://www.rimowa.com");
});

test("detectDemandware returns null for a non-Demandware page (Prada)", () => {
  const html = fx("prada_pdp_jp.html");
  const dw = detectDemandware(html, "https://www.prada.com/jp/ja/p/x/P29C26_195X_F0442_S_OOO");
  assert.equal(dw, null);
});

test("detectGlobalE finds a region-gated storefront and merchant metadata", () => {
  const html = `
    <link rel="preconnect" href="https://web.global-e.com">
    <link rel="preload" as="style" href="https://gepi.global-e.com/includes/css/806">
    <script id="globaleScript">
      var geStoreCode = 'ww';
      var geStoreCodeInstance = 'maisonkitsune.com';
      var gePreferedCulture = 'en-US';
      (function () {
        var s = document.createElement('script');
        s.src = '//gepi.global-e.com/includes/js/806';
      })();
    </script>
    <script>var algoliaConfig = {"country_cookie_name":"GlobalE_Data"};</script>
  `;
  const ge = detectGlobalE(html);
  assert.ok(ge, "should detect Global-e");
  assert.equal(ge.merchantId, "806");
  assert.equal(ge.storeCode, "ww");
  assert.equal(ge.instanceCode, "maisonkitsune.com");
  assert.equal(ge.preferredCulture, "en-US");
  assert.equal(ge.cookieName, "GlobalE_Data");
});

test("extractCode returns the terminal SKU from slugged Balenciaga URLs", () => {
  const url = "https://www.balenciaga.com/en-ca/techwear-cut-out-bodysuit-burgundy-aqua-A002EHTUVN78104.html";
  assert.equal(extractCode(url), "A002EHTUVN78104");
});

// --- Task 2: demandwareControllerUrls ---

test("demandwareControllerUrls builds Product-Show URLs per locale", () => {
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const us = demandwareControllerUrls(dw, "United States", "83273171");
  assert.deepEqual(us, [
    "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_US/Product-Show?pid=83273171",
  ]);
  const ca = demandwareControllerUrls(dw, "Canada", "83273171");
  assert.equal(ca.length, 2); // en_CA, fr_CA
  assert.ok(ca[0].includes("/en_CA/Product-Show?pid=83273171"));
  assert.ok(ca[1].includes("/fr_CA/Product-Show?pid=83273171"));
});

test("demandwareControllerUrls returns [] without a sku", () => {
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  assert.deepEqual(demandwareControllerUrls(dw, "United States", ""), []);
});

// --- Task 3: existing parser reads the controller JSON-LD (regression guard) ---

test("parseProductHtml reads price from the US Demandware controller response", () => {
  const html = fx("rimowa_ctrl_us.html");
  const p = parseProductHtml(html, "USD", "83273171");
  assert.equal(p.price, 1225);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml reads price from the KR Demandware controller response", () => {
  const html = fx("rimowa_ctrl_kr.html");
  const p = parseProductHtml(html, "KRW", "83273171");
  assert.equal(p.price, 1700000);
  assert.equal(p.currency, "KRW");
});

// --- Task 4: applyDemandwareTargets ---

test("applyDemandwareTargets prepends controller URLs ahead of existing candidates", () => {
  const targets = {
    "United States": ["https://www.rimowa.com/us/en/x/83273171.html"],
  };
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const out = applyDemandwareTargets(targets, dw, "83273171");
  assert.equal(out["United States"][0],
    "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_US/Product-Show?pid=83273171");
  assert.equal(out["United States"][1], "https://www.rimowa.com/us/en/x/83273171.html");
});

test("applyDemandwareTargets seeds countries that had no candidates", () => {
  const targets = {}; // locale-less URL case → buildCountryUrls returned {}
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const out = applyDemandwareTargets(targets, dw, "83273171");
  assert.ok(out["Japan"][0].includes("/ja_JP/Product-Show?pid=83273171"));
});

test("applyDemandwareTargets is a no-op when dw is null", () => {
  const targets = { "United States": ["https://x/y.html"] };
  const out = applyDemandwareTargets(targets, null, "83273171");
  assert.deepEqual(out, targets);
});

test("Global-e region negotiation feeds direct fetch with a market cookie", async () => {
  const geHtml = `
    <link rel="preconnect" href="https://web.global-e.com">
    <link rel="preconnect" href="https://gepi.global-e.com">
    <link rel="stylesheet" id="GEPIStyles" type="text/css" href="//gepi.global-e.com/includes/css/806">
    <script id="globaleScript">
      var geStoreCode = 'ww';
      var geStoreCodeInstance = 'maisonkitsune.com';
      var gePreferedCulture = 'en-US';
      (function () {
        var s = document.createElement('script');
        s.src = '//gepi.global-e.com/includes/js/806';
      })();
    </script>
    <script>var algoliaConfig = {"country_cookie_name":"GlobalE_Data"};</script>
  `;
  const targetUrl = "https://maisonkitsune.com/ww/bomber-jacket-beluga-6930e1c84cce7.html";
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/includes/js/806")) {
      return {
        ok: true,
        status: 200,
        text: async () => 'var n={}; n.GeBaseUrl="//gepi.global-e.com/"; n.SessionId="SID123";',
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/Localize/SetLocalize/SID123")) {
      return {
        ok: true,
        status: 200,
        text: async () => '({"CountryCode":"CA","CurrencyCode":"CAD","CultureCode":"en-GB"})',
        headers: {
          get: (name) => (String(name).toLowerCase() === "set-cookie"
            ? 'GlobalE_Data={"countryISO":"CA","currencyCode":"CAD","cultureCode":"en-GB"}; path=/; domain=global-e.com'
            : null),
        },
      };
    }
    if (String(url) === targetUrl) {
      assert.equal(init.headers.Cookie, 'GlobalE_Data={"countryISO":"CA","currencyCode":"CAD","cultureCode":"en-GB"}');
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body><div data-product-sku="6930e1c84cce7"><span class="value" content="250.00">CA$250</span></div></body></html>',
        headers: { get: () => null },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const out = await scrapeCountry([targetUrl], "Canada", "6930e1c84cce7", "dummy-firecrawl-key", mockFetch, null, false, {
    kind: "global-e",
    merchantId: "806",
    storeCode: "ww",
    instanceCode: "maisonkitsune.com",
    preferredCulture: "en-US",
    cookieName: "GlobalE_Data",
  });
  assert.equal(out.ok, true);
  assert.equal(out.price, 250);
  assert.equal(out.currency, "CAD");
  assert.equal(out.via, "direct");
  assert.ok(calls.some((c) => c.url.includes("/includes/js/806")));
  assert.ok(calls.some((c) => c.url.includes("/Localize/SetLocalize/SID123")));
  assert.ok(calls.some((c) => c.url === targetUrl));
});

test("Global-e region negotiation reports unresolved browser-state storefronts explicitly", async () => {
  const geHtml = `
    <script id="globaleScript">
      var geStoreCode = 'ww';
      var geStoreCodeInstance = 'maisonkitsune.com';
      var gePreferedCulture = 'en-US';
      (function () {
        var s = document.createElement('script');
        s.src = '//gepi.global-e.com/includes/js/807';
      })();
    </script>
    <script>var algoliaConfig = {"country_cookie_name":"GlobalE_Data"};</script>
  `;
  const targetUrl = "https://maisonkitsune.com/ww/bomber-jacket-beluga-6930e1c84cce7.html";
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/includes/js/807")) {
      return {
        ok: true,
        status: 200,
        text: async () => 'var n={}; n.GeBaseUrl="//gepi.global-e.com/"; n.SessionId="SID124";',
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/Localize/SetLocalize/SID124")) {
      return {
        ok: true,
        status: 200,
        text: async () => '({"CountryCode":"CA","CurrencyCode":"CAD","CultureCode":"en-GB"})',
        headers: {
          get: (name) => (String(name).toLowerCase() === "set-cookie"
            ? 'GlobalE_Data={"countryISO":"CA","currencyCode":"CAD","cultureCode":"en-GB"}; path=/; domain=global-e.com'
            : null),
        },
      };
    }
    if (String(url) === targetUrl) {
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body><div data-product-sku="6930e1c84cce7"><span class="value" content="450.00">450 EUR</span></div></body></html>',
        headers: { get: () => null },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const out = await scrapeCountry([targetUrl], "Canada", "6930e1c84cce7", "dummy-firecrawl-key", mockFetch, null, false, {
    kind: "global-e",
    merchantId: "807",
    storeCode: "ww",
    instanceCode: "maisonkitsune.com",
    preferredCulture: "en-US",
    cookieName: "GlobalE_Data",
  });
  assert.equal(out.ok, false);
  assert.ok(out.reason.startsWith("Region-gated storefront not localized:"), out.reason);
  assert.ok(calls.some((c) => c.url.includes("/Localize/SetLocalize/SID124")));
});

// --- structuredOnly: read structured price markup but suppress loose text guessing ---

test("structuredOnly reads Demandware value-content price markup on a consumer PDP", () => {
  const html = fx("rimowa_pdp_gb.html"); // consumer PDP, zero JSON-LD
  const honest  = parseProductHtml(html, "GBP", "83273171", { structuredOnly: true });
  assert.equal(honest.price, 850);
  assert.equal(honest.currency, "GBP");
});

test("structuredOnly still reads the controller JSON-LD price (Layer 1 unaffected)", () => {
  const html = fx("rimowa_ctrl_us.html");
  const p = parseProductHtml(html, "USD", "83273171", { structuredOnly: true });
  assert.equal(p.price, 1225);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml prefers the PDP current price over related-product prices", () => {
  const html = fx("prada_pdp_jp.html");
  const p = parseProductHtml(html, "JPY", "P29C26_195X_F0442_S_OOO");
  assert.equal(p.price, 258500);
  assert.equal(p.currency, "JPY");
});

test("parseProductHtml reads current price when ISO currency follows the amount", () => {
  const html = `<p data-element="product-current-price">1,070.00 CAD</p>`;
  const p = parseProductHtml(html, "CAD", "1HC519_2ZP6_F0018");
  assert.equal(p.price, 1070);
  assert.equal(p.currency, "CAD");
});

test("parseProductHtml prefers the rendered sales price over a struck list price", () => {
  const html = `
    <div class="product-prices prices d-flex">
      <div class="price back-to-product-anchor-js">
        <span class="default-pricing">
          <span class="sales"><span class="value"> $2,580 </span></span>
          <span class="strike-through list">
            <span class="value" content="1350.00">
              <span class="sr-only"> Was </span> $1,350 <span class="sr-only"> Is </span>
            </span>
          </span>
        </span>
      </div>
    </div>`;
  const p = parseProductHtml(html, "USD", "1023460-1A17455_2K00J");
  assert.equal(p.price, 2580);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml uses the regular price, not the sale price, on a Shopify markdown", () => {
  // Shopify (e.g. Fear of God): JSON-LD carries the live SALE price, the variant JSON carries the
  // original as compare_at_price. The comparison tool compares on the regular (pre-sale) price.
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"Classic Fleece Hoodie","offers":{"@type":"Offer","price":"75.00","priceCurrency":"USD"}}</script>
    <script>var __st = {"variants":[{"id":42631100923965,"price":7500,"compare_at_price":15000,"available":true}]};</script>`;
  const p = parseProductHtml(html, "USD", "");
  assert.equal(p.price, 150);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml keeps the current price when there is no Shopify markdown", () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"75.00","priceCurrency":"USD"}}</script>
    <script>var __st = {"variants":[{"id":1,"price":7500,"compare_at_price":null}]};</script>`;
  const p = parseProductHtml(html, "USD", "");
  assert.equal(p.price, 75);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml uses the struck-through original on a Demandware markdown (Margiela)", () => {
  // JSON-LD exposes only the sale price (3114); the original (5190) is in a strike-through span
  // right before the sales span. A recommended item's struck price (930) must NOT be picked.
  const html = `
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"3114.00","priceCurrency":"CAD"}}</script>
    <p class="strike-through list"><span class="value" itemprop="price" content="930.00"> CAD$ 930 </span></p>
    <div class="product-price"><div class="prices"><div class="price"><span>
      <span class="strike-through list"><span class="value" itemprop="price" content="5190.00"> CAD$ 5,190 </span><span class="d-none"> - Original Price </span></span>
      <span class="sales"><span class="value" itemprop="price" content="3114.00"> CAD$ 3,114 </span></span>
    </span></div></div></div>`;
  const p = parseProductHtml(html, "CAD", "");
  assert.equal(p.price, 5190);
  assert.equal(p.currency, "CAD");
});

test("parseProductHtml uses the struck original on a markdown in a no-decimal currency (KRW)", () => {
  // KRW content attributes have no ".00"; pairing must still match the current price.
  const html = `
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"4074000","priceCurrency":"KRW"}}</script>
    <div class="product-price"><div class="price"><span>
      <span class="strike-through list"><span class="value" itemprop="price" content="6790000"> ₩ 6,790,000 </span><span class="d-none"> - Original Price </span></span>
      <span class="sales"><span class="value" itemprop="price" content="4074000"> ₩ 4,074,000 </span></span>
    </span></div></div>`;
  const p = parseProductHtml(html, "KRW", "");
  assert.equal(p.price, 6790000);
  assert.equal(p.currency, "KRW");
});

test("parseProductHtml absolutizes a root-relative JSON-LD image against the page URL", () => {
  // Off-White (Demandware) exposes the product image in JSON-LD as a root-relative path and has no
  // og:image. Without a base URL it can't be proxied (cleanImageUrl drops a relative string), so the
  // photo silently fails to render. parseProductHtml must resolve it against the page it came from.
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"3D Spray Arrow Skate Hoodie","image":["/on/demandware.static/-/Sites-51/default/dwe43e4642/images/zoom/44MBB085S26F00G_001_0.jpg"],"offers":{"@type":"Offer","price":"452.00","priceCurrency":"USD"}}</script>`;
  const pageUrl = "https://www.off---white.com/en-ca/men/clothing/sweatshirts/3d-spray-arrow-skate-hoodie-44MBB085S26F00G001.html";
  const p = parseProductHtml(html, "USD", "", { pageUrl });
  assert.equal(p.image, "https://www.off---white.com/on/demandware.static/-/Sites-51/default/dwe43e4642/images/zoom/44MBB085S26F00G_001_0.jpg");
});

test("parseProductHtml extracts the URL from a JSON-LD ImageObject (not [object Object])", () => {
  // Louis Vuitton's JSON-LD image is an ImageObject (or array of them), not a string. Coercing the
  // object to a string yields "[object Object]"; resolving that against the page URL produced a
  // broken image link (.../products/.../[object Object]). Pull the object's url instead.
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"Victorine Wallet","image":[{"@type":"ImageObject","url":"https://us.louisvuitton.com/images/victorine.jpg"}],"offers":{"@type":"Offer","price":"995","priceCurrency":"USD"}}</script>`;
  const p = parseProductHtml(html, "USD", "", { pageUrl: "https://ca.louisvuitton.com/eng-ca/products/x/M29413" });
  assert.equal(p.image, "https://us.louisvuitton.com/images/victorine.jpg");
});

test("parseProductHtml rejects non-product images (Ralph Lauren social/monogram assets) → blank, not wrong", () => {
  // RL's og:image is a generic social-share card and its only CDN images are monogramming/embroidery
  // swatches under /Library-Sites- (the real polo photo is JS-lazy-loaded, absent from the HTML). An
  // honest blank beats showing a broken swatch labelled as the product.
  const html = `
    <meta property="og:image" content="https://www.ralphlauren.ca/on/demandware.static/-/Library-Sites-RalphLauren_NA_Library/default/x/images/social-sharing/RLNA-Social-Image.jpg">
    <img src="https://www.ralphlauren.ca/on/demandware.static/-/Library-Sites-RalphLauren_NA_Library/default/y/images/monogramming/embroiderycolor/C1730.jpg">
    <img src="https://www.ralphlauren.ca/on/demandware.static/Sites-RalphLauren_CA-Site/-/default/dwc1c84b9b/images/cyo-redesign.png">
    <script type="application/ld+json">{"@type":"Product","name":"The Iconic Mesh Polo","offers":{"@type":"Offer","price":"125","priceCurrency":"USD"}}</script>`;
  const p = parseProductHtml(html, "USD", "401480", { pageUrl: "https://www.ralphlauren.ca/men-clothing/x/401480-P.html" });
  assert.equal(p.price, 125);
  assert.equal(p.image, null);
});

test("parseProductHtml still takes a SKU-filename CDN image as last resort (Balenciaga case)", () => {
  // No og:image, no JSON-LD image, and the URL code (813472606) differs from the image code — but the
  // image filename is clearly a product SKU, so it should still be used.
  const html = `
    <img src="https://media.balenciaga.com/dam/images/7897792AA4V1000_F.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Bag","offers":{"@type":"Offer","price":"1450","priceCurrency":"USD"}}</script>`;
  const p = parseProductHtml(html, "USD", "813472606", { pageUrl: "https://www.balenciaga.com/en-us/x-813472606.html" });
  assert.equal(p.image, "https://media.balenciaga.com/dam/images/7897792AA4V1000_F.jpg");
});

test("parseProductHtml matches an extensionless CDN image by product code (Tom Ford / Amplience)", () => {
  // Tom Ford serves images from Amplience with NO file extension
  // (cdn.media.amplience.net/i/tom_ford/FT1362_01A_53MM_A) and exposes them only in JS state, not
  // JSON-LD/og:image. The .jpg/.png-only URL regexes miss them, so the photo never resolves.
  const html = `
    <script>window.__d = {"media":["https://cdn.media.amplience.net/i/tom_ford/FT1362_01A_53MM_A","https://cdn.media.amplience.net/i/tom_ford/FT1362_01A_53MM_B"]};</script>
    <script type="application/ld+json">{"@type":"Product","name":"PENN Sunglasses","offers":{"@type":"Offer","price":"320","priceCurrency":"EUR"}}</script>`;
  const p = parseProductHtml(html, "EUR", "FT1362", { pageUrl: "https://www.tomfordfashion.it/it-it/x/FT1362.html" });
  assert.equal(p.image, "https://cdn.media.amplience.net/i/tom_ford/FT1362_01A_53MM_A");
});

test("parseProductHtml leaves an already-absolute image URL unchanged", () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"Tote","image":"https://cdn.example.com/bag.jpg","offers":{"@type":"Offer","price":"452.00","priceCurrency":"USD"}}</script>`;
  const p = parseProductHtml(html, "USD", "", { pageUrl: "https://www.example.com/p/tote.html" });
  assert.equal(p.image, "https://cdn.example.com/bag.jpg");
});

test("scrapeOne skips Firecrawl when a candidate returns a clean 404", async () => {
  // A guessed locale URL that 404s genuinely doesn't exist; Firecrawl would only render its 404 page.
  // Skipping the render saves a subrequest + seconds per dead candidate (faster, more budget left).
  let fcCalls = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes("api.firecrawl.dev")) { fcCalls++; return { ok:true, status:200, text:async()=>"", json:async()=>({ data:{ html:"<html>x</html>" } }) }; }
    return { ok:false, status:404, text:async()=>"", json:async()=>({}) };
  };
  const r = await scrapeOne("https://brand.example.com/us/en/p/x-ABC12345.html", "United States", "ABC12345", "FAKEKEY", fakeFetch);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Not found \(404\)/);
  assert.equal(fcCalls, 0, "Firecrawl must NOT be called for a 404 candidate");
});

test("scrapeOne still falls back to Firecrawl on a 403 (bot-block)", async () => {
  // 403 = the page exists but blocks direct fetch; Firecrawl's stealth proxy can get past it.
  let fcCalls = 0;
  const html = `<script type="application/ld+json">{"@type":"Product","offers":{"price":"100","priceCurrency":"USD"}}</script><div>ABC12345</div>`;
  const fakeFetch = async (url) => {
    if (String(url).includes("api.firecrawl.dev")) { fcCalls++; return { ok:true, status:200, text:async()=>"", json:async()=>({ data:{ html } }) }; }
    return { ok:false, status:403, text:async()=>"", json:async()=>({}) };
  };
  const r = await scrapeOne("https://brand.example.com/us/en/p/x-ABC12345.html", "United States", "ABC12345", "FAKEKEY", fakeFetch);
  assert.equal(fcCalls, 1, "Firecrawl should still be tried on a 403");
  assert.equal(r.ok, true);
  assert.equal(r.price, 100);
});

test("scrapeAll seeds the input market from discovery HTML when per-country fetches fail", async () => {
  // Single-region site (Korea-only Cafe24): only the discovery fetch succeeds; every per-country
  // candidate 404s and the subrequest budget trips. The input market's price must still come back.
  const krHtml = `<script type="application/ld+json">{"@type":"Product","offers":{"price":"380000","priceCurrency":"KRW"}}</script>`;
  let n = 0;
  const fakeFetch = async () => {
    n++;
    return n === 1
      ? { ok: true, status: 200, text: async () => krHtml, json: async () => ({}) }   // discovery
      : { ok: false, status: 404, text: async () => "", json: async () => ({}) };      // everything else
  };
  const r = await scrapeAll("https://wooyoungmi.com/product/detail.html?product_no=7656", "FAKEKEY", fakeFetch, null);
  assert.equal(r.found, true);
  assert.ok(r.prices["South Korea"], "Korea should be seeded from discovery HTML");
  assert.equal(r.prices["South Korea"].price, 380000);
  assert.ok(n < 50, `subrequest ceiling should hold (was ${n})`);
});

test("scrapeAll drops a market priced under 0.4x the peer median (Le Labo cheap-variant case)", async () => {
  // A JS-rendered multi-variant page (Le Labo) can leave a cheap travel/refill/sample price as the
  // only number the parser finds, faking a "cheapest" market. A price under 40% of the peer median
  // is virtually always such an error, so it must be rejected rather than reported as cheapest.
  const mk = (cur, price) =>
    `<script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"@type":"Offer","price":"${price}","priceCurrency":"${cur}"}}</script><div>ABC123456</div>`;
  const P = { us: ["USD", "200"], ca: ["CAD", "60"], fr: ["EUR", "185"], it: ["EUR", "185"] }; // CA 60 CAD ≈ $44 ≈ 0.22x median
  const fakeFetch = async (url) => {
    const cc = (new URL(url).pathname.split("/")[1] || "").toLowerCase();
    const v = P[cc];
    const html = v ? mk(v[0], v[1]) : "<html>no product here</html>";
    return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
  };
  const r = await scrapeAll("https://brand.example.com/us/en/p/widget-ABC123456.html", "FAKEKEY", fakeFetch, null);
  assert.equal(r.found, true);
  assert.ok(r.prices["United States"] && r.prices["France"] && r.prices["Italy"], "real-price markets stay");
  assert.ok(!r.prices["Canada"], "the sub-0.4x cheap variant must be dropped");
  assert.ok((r.failed || []).some(f => f.country === "Canada" && /out of line/.test(f.reason)), "Canada flagged out of line");
});
