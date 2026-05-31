import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  detectDemandware,
  demandwareControllerUrls,
  applyDemandwareTargets,
  extractCode,
  parseProductHtml,
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
